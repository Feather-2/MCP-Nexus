import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Locale = 'en' | 'zh';

const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const cache: Partial<Record<Locale, Record<string, string>>> = {};
const VALID_LOCALES = new Set<string>(['en', 'zh']);

let currentLocale: Locale = 'en';
let dictionary = loadLocale(currentLocale);

export function loadLocale(locale: Locale): Record<string, string> {
  if (!VALID_LOCALES.has(locale)) throw new Error(`Invalid locale: ${locale}`);

  const cached = cache[locale];
  if (cached) {
    return cached;
  }

  const file = join(LOCALE_DIR, `${locale}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const messages: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      messages[key] = value;
    }
  }

  cache[locale] = messages;
  return messages;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  dictionary = loadLocale(locale);
}

export function getLocale(): Locale {
  return currentLocale;
}

export function parseAcceptLanguage(header?: string): Locale {
  if (!header) return currentLocale;
  const normalized = header.trim().toLowerCase();
  if (normalized.startsWith('zh')) return 'zh';
  return 'en';
}

export function t(key: string, params?: Record<string, string | number>): string {
  const template = dictionary[key];
  if (!template) {
    return key;
  }

  if (!params) {
    return template;
  }

  return template.replace(/\{([^}]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}
