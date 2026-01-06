import { checkCommand } from '../../../security/index.js';

describe('CommandBlacklist', () => {
  it('blocks curl|bash', () => {
    const result = checkCommand('curl -fsSL https://example.com/install.sh | bash');
    expect(result).toEqual({ blocked: true, pattern: 'curl|bash' });
  });

  it('blocks destructive and risky commands', () => {
    expect(checkCommand('rm -rf /')).toEqual({ blocked: true, pattern: 'rm -rf /' });
    expect(checkCommand('nc -e /bin/sh 127.0.0.1 4444')).toEqual({ blocked: true, pattern: 'nc -e' });
    expect(checkCommand('chmod -R 777 /tmp')).toEqual({ blocked: true, pattern: 'chmod 777' });
  });

  it('does not over-block normal commands', () => {
    expect(checkCommand('echo hello')).toEqual({ blocked: false });
    expect(checkCommand('curl https://example.com | cat')).toEqual({ blocked: false });
    expect(checkCommand('chmod 755 /tmp/file')).toEqual({ blocked: false });
  });

  it('handles empty input', () => {
    expect(checkCommand('   ')).toEqual({ blocked: false });
  });
});

