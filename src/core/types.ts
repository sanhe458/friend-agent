export type ChannelId = string;

export interface Binding {
  channel: ChannelId;
  externalId: string;
  verifiedAt?: number;
  displayName?: string;
}

export interface Person {
  id: string;
  displayName: string;
  bindings: Binding[];
  /** 惯用通道（兜底）：回注优先级 = 本条通道 ▸ preferredChannel ▸ 发起通道 */
  preferredChannel?: ChannelId;
  /** 这个人单独用哪套人格（不设 = 用全局默认） */
  personaId?: string;
  createdAt: number;
}

export type ChatType = 'private' | 'group';

export interface MediaRef {
  kind: 'image' | 'file' | 'audio';
  url?: string;
  path?: string;
}

export interface Inbound {
  channel: ChannelId;
  chatType: ChatType;
  /** 发送者在通道内的 id */
  externalId: string;
  text?: string;
  media?: MediaRef[];
  at: number;
  /** 通道自带的名字（Telegram 的 first_name、QQ 的昵称…）；用于首次建档时先给个可读的称呼 */
  name?: string;
}

export interface Outbound {
  channel: ChannelId;
  to: string;
  text: string;
  media?: MediaRef[];
}

export interface Capabilities {
  maxTextLen: number;
  media: string[];
  typing?: boolean;
}
