import { WeatherTool } from './src/tools/weather.js';

async function test() {
  const tool = new WeatherTool();

  console.log('Testing: Springfield Ohio');
  const result1 = await tool.execute({ location: 'Springfield Ohio' });
  console.log('Result:', result1, '\n');

  console.log('Testing: Portland Oregon');
  const result2 = await tool.execute({ location: 'Portland Oregon' });
  console.log('Result:', result2, '\n');

  console.log('Testing: Portland Maine');
  const result3 = await tool.execute({ location: 'Portland Maine' });
  console.log('Result:', result3);
}

test();
