import { WeatherTool } from './src/tools/weather.js';

async function test() {
  const tool = new WeatherTool();

  console.log('=== Testing WITHOUT comma (spoken) ===');
  console.log('Testing: "Austin Texas"');
  const result1 = await tool.execute({ location: 'Austin Texas' });
  console.log('Result:', result1, '\n');

  console.log('=== Testing WITH comma (Claude formatted) ===');
  console.log('Testing: "Austin, Texas"');
  const result2 = await tool.execute({ location: 'Austin, Texas' });
  console.log('Result:', result2, '\n');

  console.log('=== Testing "Springfield Ohio" ===');
  const result3 = await tool.execute({ location: 'Springfield Ohio' });
  console.log('Result:', result3);
}

test();
