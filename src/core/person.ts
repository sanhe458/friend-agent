import type { Persistence } from '../store/persist.ts';
import type { Binding, ChannelId, Person } from './types.ts';

const VERIFY_TTL_MS = 10 * 60_000;
/** 一个验证码最多被试几次；超了就作废（防在本方对话里狂发 6 位数字硬猜） */
const MAX_CODE_TRIES = 6;
/** id 带时间戳：重启后不会撞上已恢复的旧档案（以前靠自增 seq，重启归零就可能覆盖别人的档案） */
const newId = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

interface PendingMerge { code: string; personId: string; binding: Binding; expiresAt: number; tries: number }

/**
 * 身份解析 + 跨通道合并。
 *
 * 硬规则：验证必须在「已知通道」内完成动作 —— 光凭一句「我是 XX」绝不合并。
 * 流程：TG 声称 → requestMerge 向已知通道(QQ)发验证码 → 用户在 QQ 回码 → confirmMerge。
 */
export class IdentityService {
  #people = new Map<string, Person>();
  #pending = new Map<string, PendingMerge>();
  /** channel:externalId → personId（find 别每次线性扫全部人） */
  #index = new Map<string, string>();
  #persist?: Persistence;

  constructor(persist?: Persistence) {
    this.#persist = persist;
    if (persist?.enabled) {
      for (const p of persist.loadPersons()) {
        this.#people.set(p.id, p);
        for (const b of p.bindings) this.#index.set(`${b.channel}:${b.externalId}`, p.id);
      }
    }
  }

  #save(p: Person): void { this.#persist?.savePerson(p); }

  /** 把绑定记进索引（合并/建档后都要调） */
  #indexAdd(personId: string, b: Binding): void { this.#index.set(`${b.channel}:${b.externalId}`, personId); }

  /** 清掉过期/用尽的待确认项（没人清就会一直涨） */
  #sweep(): void {
    const now = Date.now();
    for (const [code, p] of this.#pending) {
      if (p.expiresAt < now || p.tries >= MAX_CODE_TRIES) this.#pending.delete(code);
    }
  }

  /** 未知身份自动建档；已知则直接返回。name 只在“还没被起过名”时生效，不会覆盖人工/AI 起的称呼 */
  resolve(channel: ChannelId, externalId: string, name?: string): Person {
    const found = this.find(channel, externalId);
    if (found) {
      // 仍是 channel:externalId 这种机器串 → 用通道自带的名字补上可读的
      if (name && this.#isMachineName(found, channel, externalId) && name.trim()) {
        found.displayName = name.trim().slice(0, 40);
        this.#save(found);
      }
      return found;
    }

    const person: Person = {
      id: newId(),
      displayName: (name && name.trim()) ? name.trim().slice(0, 40) : `${channel}:${externalId}`,
      bindings: [{ channel, externalId, verifiedAt: Date.now(), displayName: name }],
      createdAt: Date.now(),
    };
    this.#people.set(person.id, person);
    this.#indexAdd(person.id, person.bindings[0]);
    this.#save(person);
    return person;
  }

  /** 称呼还是默认的「通道:id」机器串吗 */
  #isMachineName(p: Person, channel: ChannelId, externalId: string): boolean {
    return p.displayName === `${channel}:${externalId}` || !p.displayName.trim();
  }

  /**
   * 改称呼（显示名）。AI 主动起名 / 人工在面板改都走这里。
   * 重名不阻止（现实里就是会重名），但要告诉调用方——否则以后选人会选错。
   */
  setDisplayName(personId: string, name: string): { person: Person; duplicateOf: Person[] } {
    const p = this.#people.get(personId);
    if (!p) throw new Error('没有这个人');
    const n = String(name ?? '').trim().slice(0, 40);
    if (!n) throw new Error('称呼不能为空');
    p.displayName = n;
    this.#save(p);
    const duplicateOf = [...this.#people.values()].filter(
      (x) => x.id !== p.id && x.displayName.trim() === n,
    );
    return { person: p, duplicateOf };
  }

  find(channel: ChannelId, externalId: string): Person | undefined {
    const id = this.#index.get(`${channel}:${externalId}`);
    if (id) {
      const p = this.#people.get(id);
      if (p) return p;
      this.#index.delete(`${channel}:${externalId}`); // 索引失效自愈
    }
    // 兜底：索引没命中就扫一遍（比如旧数据直接改了库）
    for (const p of this.#people.values()) {
      if (p.bindings.some((b) => b.channel === channel && b.externalId === externalId)) {
        this.#indexAdd(p.id, { channel, externalId, verifiedAt: Date.now() } as Binding);
        return p;
      }
    }
    return undefined;
  }

  /**
   * 发起「把两个对话认成同一个人」的验证。
   *
   * newSide   = 当前这个对话（刚发起合并的一方）
   * knownSide = 已经确认存在的另一个对话
   *
   * 验证码发到 **knownSide**（证明你确实能在那个对话里收到），
   * 然后必须回到 **newSide** 里把码回出来（证明两边是同一个人在操作）。
   * 这样才真的证明“两个不同对话归同一个人”。
   */
  requestMerge(newSide: Binding, knownSide: { channel: ChannelId; externalId: string }) {
    const known = this.find(knownSide.channel, knownSide.externalId);
    if (!known) throw new Error('另一个对话还没有档案');
    if (known.bindings.some((b) => b.channel === newSide.channel && b.externalId === newSide.externalId)) {
      throw new Error('这两个对话已经是同一个人了');
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.#sweep();
    this.#pending.set(code, {
      code, personId: known.id, binding: newSide, expiresAt: Date.now() + VERIFY_TTL_MS, tries: 0,
    });
    return {
      code,
      // 码送到这个对话
      notify: { channel: knownSide.channel, to: knownSide.externalId, personId: known.id },
      // 要在这个对话里回码
      confirmIn: { channel: newSide.channel, externalId: newSide.externalId },
    };
  }

  /** 必须由「发起合并的那个对话」确认（码是从另一个对话拿到的） */
  confirmMerge(code: string, via: { channel: ChannelId; externalId: string }): Person {
    const pending = this.#pending.get(code);
    if (!pending) throw new Error('验证码无效');
    if (pending.expiresAt < Date.now()) { this.#pending.delete(code); throw new Error('验证码已过期'); }

    // ⚠️ 防爆破：验证码只有 6 位（90 万种），而 tryConfirm 对**每条入站消息**都会跑，
    //    攻击者能在自己那个对话里狂发六位数字硬猜，猜中就把自己的对话并进别人的档案。
    //
    //    但计数**必须按「谁在试」分开**：
    //      · 不在发起对话里的尝试（比如用户在错误的窗口里回码）—— 只拦下，不计数。
    //        以前这里是全局 tries++，于是**在错误窗口回一次就把整张验证码废掉**了，
    //        正确窗口再去回就永远是「验证码无效」（演示第 3 步就是这么挂的，真实场景里
    //        用户手滑在别的对话回一次码，也再也没法合并）。
    //      · 只在发起对话里的错误尝试才累计，累计到上限作废。
    //    这对攻击者毫无损失（他本来就只能在发起对话里猜），却修掉了误伤。
    if (via.channel !== pending.binding.channel || via.externalId !== pending.binding.externalId) {
      throw new Error('验证码要在发起合并的那个对话里回复');
    }

    const owner = this.#people.get(pending.personId);
    if (!owner) throw new Error('目标身份已不存在');

    // 合并：把 from 的 binding 挂到 owner；原临时 person 若退化为空则删除
    const orphan = this.find(pending.binding.channel, pending.binding.externalId);
    if (orphan && orphan.id !== owner.id) {
      orphan.bindings = orphan.bindings.filter(
        (b) => !(b.channel === pending.binding.channel && b.externalId === pending.binding.externalId),
      );
      if (orphan.bindings.length === 0) {
        this.#people.delete(orphan.id);
        this.#persist?.deletePerson(orphan.id);
      } else {
        this.#save(orphan); // 还剩别的绑定，得把删掉的那条写回去
      }
    }
    if (!owner.bindings.some((b) => b.channel === pending.binding.channel && b.externalId === pending.binding.externalId)) {
      owner.bindings.push({ ...pending.binding, verifiedAt: Date.now() });
    }
    this.#indexAdd(owner.id, pending.binding);
    this.#pending.delete(code);
    this.#save(owner);
    return owner;
  }

  /**
   * 入站钩子专用：**猜码**路径。
   * 与 confirmMerge 的区别是这里会累计爆破计数——只有来源于「发起合并的那个对话」
   * 的**错误码**才计数（那才是攻击者的猜码行为）。对码成功则直接合并。
   */
  tryConfirm(code: string, via: { channel: ChannelId; externalId: string }): Person | undefined {
    // 先看这个 via 有没有待确认项；没有就直接返回（不算任何人的错）
    const mine = this.#pendingFor(via);
    try {
      const p = this.confirmMerge(code, via);
      return p;
    } catch {
      // 猜码失败：只有「本来就在发起对话里、却猜错码」才累计
      if (mine) {
        mine.tries += 1;
        if (mine.tries >= MAX_CODE_TRIES) this.#pending.delete(mine.code);
      }
      return undefined;
    }
  }

  /** via 名下的待确认项（含对象引用，供计数用） */
  #pendingFor(via: { channel: ChannelId; externalId: string }): PendingMerge | undefined {
    for (const p of this.#pending.values()) {
      if (p.binding.channel === via.channel && p.binding.externalId === via.externalId) {
        return p.expiresAt >= Date.now() ? p : undefined;
      }
    }
    return undefined;
  }

  /** 给这个人换人格（personaId 传空 = 恢复用全局默认） */
  setPersona(personId: string, personaId?: string): Person {
    const p = this.#people.get(personId);
    if (!p) throw new Error('没有这个人');
    if (personaId) p.personaId = personaId;
    else delete p.personaId;
    this.#save(p);
    return p;
  }

  all(): Person[] { return [...this.#people.values()]; }

  /** 这个对话有没有待确认的合并（入站钩子用） */
  pendingFor(via: { channel: ChannelId; externalId: string }): { code: string; expiresAt: number } | undefined {
    for (const [code, p] of this.#pending) {
      if (p.binding.channel === via.channel && p.binding.externalId === via.externalId) {
        return p.expiresAt >= Date.now() ? { code, expiresAt: p.expiresAt } : undefined;
      }
    }
    return undefined;
  }

  /** 设置惯用通道（回注兜底目标） */
  setPreferred(personId: string, channel?: string): Person {
    const p = this.#people.get(personId);
    if (!p) throw new Error('没有这个人');
    if (channel && !p.bindings.some((b) => b.channel === channel)) throw new Error('这个人没有该通道的绑定');
    p.preferredChannel = channel;
    this.#save(p);
    return p;
  }
}
