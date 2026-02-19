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
      // Try multiple location formats to handle spoken input
      const locationVariants = this.normalizeLocation(location);

      let geoData: {
        results?: Array<{
          name: string;
          latitude: number;
          longitude: number;
          country: string;
          admin1?: string;
        }>;
      } | null = null;

      // Try each variant until we get results
      for (const variant of locationVariants) {
        const geoResponse = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=10&language=en&format=json`
        );

        if (geoResponse.ok) {
          const data = await geoResponse.json() as typeof geoData;
          if (data?.results && data.results.length > 0) {
            // If original input had multiple words, try to match the region/state/country
            const bestMatch = this.findBestMatch(location, data.results);
            geoData = { results: [bestMatch] };
            console.log(`Geocoded "${location}" using variant: "${variant}" → ${bestMatch.name}, ${bestMatch.admin1 || ''}, ${bestMatch.country}`);
            break;
          }
        }
      }

      if (!geoData?.results || geoData.results.length === 0) {
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

  // Find the best matching location from multiple results
  // Uses state/country hints from the original query
  private findBestMatch(
    originalLocation: string,
    results: Array<{ name: string; admin1?: string; country: string }>
  ): { name: string; latitude: number; longitude: number; country: string; admin1?: string } {
    const words = originalLocation.toLowerCase().trim().split(/\s+/);

    // If multiple words, use the last word(s) as a region hint
    if (words.length >= 2) {
      const regionHint = words.slice(1).join(' '); // "Austin Texas" → "texas"

      // Try to match against admin1 (state/province) or country
      for (const result of results as any[]) {
        const admin1Lower = result.admin1?.toLowerCase() || '';
        const countryLower = result.country.toLowerCase();

        // Check for exact or partial match
        if (
          admin1Lower === regionHint ||
          admin1Lower.includes(regionHint) ||
          regionHint.includes(admin1Lower) ||
          countryLower === regionHint ||
          countryLower.includes(regionHint)
        ) {
          console.log(`Matched region hint "${regionHint}" to ${result.name}, ${result.admin1}, ${result.country}`);
          return result;
        }
      }
    }

    // No region match found, return first (most populous/important)
    return results[0] as any;
  }

  // Normalize spoken location formats for better geocoding
  // Handles: "Austin Texas" → "Austin, Texas", "New York" → "New York", etc.
  private normalizeLocation(location: string): string[] {
    const variants: string[] = [];

    // Always try the original first
    variants.push(location);

    // Split into words (handle both comma-separated and space-separated)
    const parts = location.split(',').map(p => p.trim());
    const words = parts.length > 1
      ? parts[0].split(/\s+/)  // "Austin, Texas" → ["Austin"]
      : location.split(/\s+/);  // "Austin Texas" → ["Austin", "Texas"]

    if (location.includes(',')) {
      // Has comma: "Austin, Texas" or "New York, New York"
      // Try without comma as fallback
      if (parts.length === 2) {
        variants.push(`${parts[0]} ${parts[1]}`);  // "Austin, Texas" → "Austin Texas"
        variants.push(parts[0]);  // Just city: "Austin"
      }
    } else {
      // No comma: "Austin Texas" or "New York City"
      if (words.length === 2) {
        // "Austin Texas" → "Austin, Texas"
        variants.push(`${words[0]}, ${words[1]}`);
        variants.push(words[0]);  // Fallback to just city
      } else if (words.length === 3) {
        // "New York City" or "New York New York"
        variants.push(`${words[0]} ${words[1]}, ${words[2]}`);
        variants.push(`${words[0]} ${words[1]}`);
        variants.push(words[0]);
      } else if (words.length > 1) {
        variants.push(words[0]);  // Fallback to first word
      }
    }

    return variants;
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
