/**
 * Deliberately coarse user-agent parsing.
 *
 * We only ever resolve a UA down to a browser family, OS family and a
 * three-way device class. That is enough for a useful breakdown and far too
 * little to identify anyone — which is the point. Nothing here is stored
 * against a persistent identifier.
 */

export interface UaInfo {
  browser: string;
  os: string;
  device: string;
}

const BOT_PATTERN =
  /bot|crawler|spider|crawl|slurp|headless|phantom|puppeteer|playwright|lighthouse|pingdom|uptime|monitor|scanner|curl\/|wget\/|python-requests|go-http-client|axios\/|node-fetch|okhttp|java\/|libwww|facebookexternalhit|embedly|quora link preview|preview|fetcher|archiver|validator|feedburner|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|ccbot|claudebot|perplexity|amazonbot|applebot/i;

export function isBot(ua: string): boolean {
  return ua === '' || BOT_PATTERN.test(ua);
}

// Order matters: many browsers impersonate the ones below them.
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bBrave\//, 'Brave'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bYaBrowser\//, 'Yandex'],
  [/\bDuckDuckGo\//, 'DuckDuckGo'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrome\/|\bChromium\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\bWindows NT\b/, 'Windows'],
  [/\bAndroid\b/, 'Android'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

export function parseUa(ua: string): UaInfo {
  let browser = 'Other';
  for (const [pattern, name] of BROWSERS) {
    if (pattern.test(ua)) {
      browser = name;
      break;
    }
  }

  let os = 'Other';
  for (const [pattern, name] of SYSTEMS) {
    if (pattern.test(ua)) {
      os = name;
      break;
    }
  }

  let device = 'Desktop';
  if (/\biPad\b|\bTablet\b|\bPlayBook\b|\b(?:Android(?!.*Mobile))\b/.test(ua)) {
    device = 'Tablet';
  } else if (/\bMobi\b|\bMobile\b|\biPhone\b|\biPod\b|\bAndroid\b/.test(ua)) {
    device = 'Mobile';
  }

  return { browser, os, device };
}
