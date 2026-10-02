/**
 * 查天气工具。
 *
 * 数据源：wttr.in（免费、免 key），备镜像 wttr.is。
 * ⚠️ 三个坑（都实测过）：
 *  1. **必须用 curl 风格的 User-Agent**——否则 wttr.in 返回面向浏览器的 HTML 而不是 JSON；
 *  2. `format=j2` 里 **hourly 是空的**（所以拿不到每天的天气描述），要用 `j1`；
 *  3. `lang=zh` 的中文翻译**不生效**（lang_zh 回的仍是英文）——
 *     所以改用与语言无关的 `weatherCode`（WW0 国际气象码）自己映射中文。
 */

export interface WeatherDeps {
  /** 没指定地点时用的默认位置（三河在湖南常德桃源） */
  defaultLocation?: string;
  /** 便于测试时注入 */
  fetchFn?: typeof fetch;
}

const HOSTS = ['https://wttr.in', 'https://wttr.is'];

/** WWO 气象码 → 中文（与语言无关，比 wttr.in 的 lang=zh 可靠） */
const WWO_ZH: Record<string, string> = {
  '113': '晴', '116': '多云', '119': '阴', '122': '阴天',
  '143': '薄雾', '248': '雾', '260': '冻雾',
  '176': '局部有雨', '263': '局部小毛毛雨', '266': '小毛毛雨', '293': '局部小雨', '296': '小雨',
  '299': '间歇中雨', '302': '中雨', '305': '间歇大雨', '308': '大雨', '353': '小阵雨',
  '356': '中到大阵雨', '359': '暴雨', '386': '局部雷阵雨', '389': '中到大雷阵雨', '200': '附近有雷阵雨',
  '179': '局部有雪', '227': '吹雪', '230': '暴雪', '320': '中到大雨夹雪', '323': '局部小雪',
  '326': '小雪', '329': '局部中雪', '332': '中雪', '335': '局部大雪', '338': '大雪',
  '368': '小阵雪', '371': '中到大阵雪', '392': '局部雷雪', '395': '中到大雷雪',
  '182': '局部雨夹雪', '185': '局部冻毛毛雨', '281': '冻毛毛雨', '284': '强冻毛毛雨',
  '311': '小冻雨', '314': '中到大冻雨', '317': '小雨夹雪', '350': '冰粒',
  '362': '小阵雨夹雪', '365': '中到大阵雨夹雪', '374': '小冰粒阵', '377': '中到大冰粒阵',
};

/** 把天气码（或英文描述）变成中文 */
function zhCondition(code: unknown, fallbackDesc: string): string {
  const c = String(code ?? '').trim();
  return WWO_ZH[c] || fallbackDesc || '未知';
}

interface WttrJson {
  current_condition?: Array<Record<string, any>>;
  nearest_area?: Array<Record<string, any>>;
  weather?: Array<Record<string, any>>;
}

const pick = (v: any): string => {
  if (Array.isArray(v)) return String(v[0]?.value ?? v[0] ?? '');
  if (v && typeof v === 'object') return String(v.value ?? '');
  return v == null ? '' : String(v);
};

/** 拿原始 JSON（带镜像回退） */
export async function fetchWeatherJson(location: string, fetchFn: typeof fetch = fetch): Promise<WttrJson> {
  const loc = String(location || '').trim() || '常德';
  let lastErr: Error | undefined;
  for (const host of HOSTS) {
    try {
      const url = `${host}/${encodeURIComponent(loc)}?format=j1`;
      const r = await fetchFn(url, {
        headers: { 'User-Agent': 'curl/8.5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      const j = JSON.parse(txt) as WttrJson; // 拿到 HTML 时这里会抛，正好触发换镜像
      if (!j?.current_condition?.length && !j?.weather?.length) throw new Error('返回里没有天气数据');
      return j;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw new Error(`查天气失败（两个源都试过了）：${lastErr?.message ?? '未知'}`);
}

/** 把 JSON 整理成一小段中文，方便直接塞进提示词 */
export function formatWeather(j: WttrJson, days = 3): string {
  const cur = j.current_condition?.[0] ?? {};
  const area = j.nearest_area?.[0] ?? {};
  const where = [pick(area.areaName), pick(area.region), pick(area.country)].filter(Boolean).join('，');
  const lines: string[] = [];

  const cond = zhCondition(cur.weatherCode, pick(cur.weatherDesc));
  const parts = [
    `${cond}`,
    `${cur.temp_C ?? '?'}°C`,
    cur.FeelsLikeC != null ? `体感 ${cur.FeelsLikeC}°C` : '',
    cur.humidity != null ? `湿度 ${cur.humidity}%` : '',
    cur.precipMM != null && Number(cur.precipMM) > 0 ? `降水 ${cur.precipMM}mm` : '',
    cur.windspeedKmph != null ? `风 ${cur.winddir16Point ?? ''}${cur.windspeedKmph}km/h` : '',
    cur.visibility != null ? `能见度 ${cur.visibility}km` : '',
  ].filter(Boolean);

  lines.push(`${where || '当前位置'} 现在：${parts.join('，')}`);

  const w = (j.weather ?? []).slice(0, Math.max(1, days));
  for (const d of w) {
    // 取当天中间那个小时段（比 0 点更有代表性）
    const hours: any[] = d.hourly ?? [];
    const mid = hours[Math.min(4, Math.max(0, hours.length - 1))] ?? {};
    const c = mid.weatherCode != null ? zhCondition(mid.weatherCode, pick(mid.weatherDesc)) : '';
    const rain = hours.reduce((mx, h) => Math.max(mx, Number(h.chanceofrain ?? 0)), 0);
    lines.push(
      `${d.date}：${d.mintempC ?? '?'}~${d.maxtempC ?? '?'}°C`
      + (c ? ` ${c}` : '')
      + (rain ? `，降雨概率最高 ${rain}%` : ''),
    );
  }
  const sun = j.weather?.[0]?.astronomy?.[0];
  if (sun?.sunrise && sun?.sunset) lines.push(`日出 ${sun.sunrise}，日落 ${sun.sunset}`);
  return lines.join('\n');
}

/** 一步到位：查 + 格式化 */
export async function getWeather(location: string, deps: WeatherDeps = {}, days = 3): Promise<string> {
  const loc = String(location || '').trim() || deps.defaultLocation || '常德';
  const j = await fetchWeatherJson(loc, deps.fetchFn ?? fetch);
  return formatWeather(j, days);
}

/** 注册成 agent 工具 */
export function registerWeatherTool(
  reg: { register: (t: any) => unknown },
  deps: WeatherDeps = {},
): void {
  reg.register({
    name: 'weather',
    description: '查天气：现在天气 + 未来几天预报（温度、体感、湿度、降水、风、降雨概率、日出日落）。不传 location 就用默认地点。',
    schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市/地区名，如 常德、北京、桃源县；不传 = 默认地点' },
        days: { type: 'number', description: '要几天预报，默认 3' },
      },
    },
    timeoutMs: 12_000,
    run: async (args: any) => {
      const days = Number.isFinite(Number(args?.days)) ? Math.min(Math.max(Number(args.days), 1), 7) : 3;
      return getWeather(String(args?.location ?? ''), deps, days);
    },
  });
}
