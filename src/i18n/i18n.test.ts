import { getLocale, loadLocale, setLocale, t } from './index.js';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('returns translation for existing key', () => {
    expect(t('errors.bad_request')).toBe('Invalid request');
  });

  it('supports parameter interpolation', () => {
    expect(t('errors.skill_not_found', { name: 'foo' })).toBe('Skill not found: foo');
  });

  it('falls back to key when missing', () => {
    expect(t('errors.unknown_key')).toBe('errors.unknown_key');
  });

  it('switches locale with setLocale/getLocale', () => {
    setLocale('zh');
    expect(getLocale()).toBe('zh');
    expect(t('errors.bad_request')).toBe('无效请求');
  });

  it('loads zh locale dictionary', () => {
    const zh = loadLocale('zh');
    expect(zh['auth.token_not_found']).toBe('未找到 Token');
  });
});
