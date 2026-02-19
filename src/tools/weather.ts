// Weather tool using Open-Meteo API (free, no key required)

import type { Tool, ToolDefinition } from './types.js';

export class WeatherTool implements Tool {
  definition: ToolDefinition = {
    name: 'get_weather',
    description: 'Get current weather conditions for a location. Returns temperature, conditions, humidity, and wind speed.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name or location (e.g., "Austin, Texas" or "New York")',
        },
      },
      required: ['location'],
    },
  };

  async execute(input: Record<string, any>): Promise<string> {
    const location = input.location as string;

    try {
      // Step 1: Geocode the location to get coordinates
      const geoResponse = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
      );

      if (!geoResponse.ok) {
        return `Unable to find location: ${location}`;
      }

      const geoData = await geoResponse.json() as {
        results?: Array<{
          name: string;
          latitude: number;
          longitude: number;
          country: string;
          admin1?: string;
        }>;
      };

      if (!geoData.results || geoData.results.length === 0) {
        return `Could not find weather data for: ${location}`;
      }

      const place = geoData.results[0];
      const { latitude, longitude, name, admin1, country } = place;

      // Step 2: Get current weather for those coordinates
      const weatherResponse = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`
      );

      if (!weatherResponse.ok) {
        return `Unable to retrieve weather data for ${location}`;
      }

      const weatherData = await weatherResponse.json() as {
        current: {
          temperature_2m: number;
          relative_humidity_2m: number;
          weather_code: number;
          wind_speed_10m: number;
        };
      };

      const current = weatherData.current;
      const condition = this.getWeatherDescription(current.weather_code);
      const locationName = admin1 ? `${name}, ${admin1}, ${country}` : `${name}, ${country}`;

      return `Current weather in ${locationName}: ${condition}, ${Math.round(current.temperature_2m)}°F, humidity ${current.relative_humidity_2m}%, wind ${Math.round(current.wind_speed_10m)} mph`;

    } catch (error) {
      console.error('Weather tool error:', error);
      return `Sorry, I encountered an error getting weather for ${location}`;
    }
  }

  // Map WMO weather codes to descriptions
  // https://open-meteo.com/en/docs
  private getWeatherDescription(code: number): string {
    if (code === 0) return 'clear sky';
    if (code <= 3) return 'partly cloudy';
    if (code <= 49) return 'foggy';
    if (code <= 59) return 'drizzle';
    if (code <= 69) return 'rain';
    if (code <= 79) return 'snow';
    if (code <= 84) return 'rain showers';
    if (code <= 86) return 'snow showers';
    if (code <= 99) return 'thunderstorm';
    return 'unknown';
  }
}
