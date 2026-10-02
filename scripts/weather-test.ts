import { getWeather } from '../src/tools/weather.ts';

/** 天气工具自检：中文城市、默认地点、英文城市各查一遍 */
for (const loc of ['常德', '北京', 'London']) {
  console.log(`=== ${loc} ===`);
  try {
    console.log(await getWeather(loc));
  } catch (err) {
    console.log('  ❌ ' + (err as Error).message);
  }
  console.log('');
}
process.exit(0);
