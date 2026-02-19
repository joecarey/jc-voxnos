import { WeatherTool } from './src/tools/weather.js';

const tool = new WeatherTool();
const result = await tool.execute({ location: 'Austin Texas' });
console.log('Result:', result);
