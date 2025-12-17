import { CommandValidator } from '../../security/index.js';

describe('CommandValidator', () => {
  it('allows a normal command', () => {
    const v = new CommandValidator();
    expect(() => v.validate('echo hello')).not.toThrow();
    expect(() => v.validate('FOO=bar echo hello')).not.toThrow();
  });

  it('blocks banned commands (including paths and Windows extensions)', () => {
    const v = new CommandValidator();
    expect(() => v.validate('dd if=/dev/zero of=/dev/null bs=1 count=1')).toThrow(/banned command/i);
    expect(() => v.validate('/bin/dd if=/dev/zero of=/dev/null')).toThrow(/dd/i);
    expect(() => v.validate('C:\\\\Windows\\\\System32\\\\shutdown.exe /s')).toThrow(/shutdown/i);
  });

  it('blocks banned fragments', () => {
    const v = new CommandValidator();
    expect(() => v.validate('rm -rf /')).toThrow(/banned fragment/i);
    expect(() => v.validate('rm -fr /')).toThrow(/banned fragment/i);
  });

  it('blocks shell metacharacters by default', () => {
    const v = new CommandValidator();
    expect(() => v.validate('echo hi | cat')).toThrow(/metacharacters/i);
    expect(() => v.validate('echo hi; whoami')).toThrow(/metacharacters/i);
    expect(() => v.validate('echo $(whoami)')).toThrow(/metacharacters/i);
  });

  it('allows shell metacharacters when enabled, but still blocks dangerous fragments', () => {
    const v = new CommandValidator();
    v.setAllowShellMeta(true);
    expect(() => v.validate('echo hi | cat')).not.toThrow();
    expect(() => v.validate('echo hi > /dev/null')).toThrow(/banned fragment/i);
  });

  it('enforces max command length', () => {
    const v = new CommandValidator({ maxCommandBytes: 16 });
    expect(() => v.validate('x'.repeat(17))).toThrow(/command too long/i);
  });

  it('enforces max argument count', () => {
    const v = new CommandValidator({ maxArgs: 3 });
    expect(() => v.validate('echo a b c')).toThrow(/too many arguments/i);
  });

  it('rejects empty commands and unparsable input', () => {
    const v = new CommandValidator();
    expect(() => v.validate('   ')).toThrow(/empty command/i);
    expect(() => v.validate('""')).toThrow(/empty command/i);
    expect(() => v.validate('echo "unterminated')).toThrow(/parse failed/i);
    expect(() => v.validate('echo foo' + '\\\\')).not.toThrow(); // escaped backslash is valid
    expect(() => v.validate('echo foo' + '\\')).toThrow(/parse failed/i); // dangling escape
  });

  it('rejects control characters', () => {
    const v = new CommandValidator();
    expect(() => v.validate('echo hi\u0000there')).toThrow(/control characters/i);
  });

  it('supports custom banned commands and fragments', () => {
    const v = new CommandValidator();
    v.addBannedCommand('curl', 'network exfiltration');
    expect(() => v.validate('curl https://example.com')).toThrow(/network exfiltration/i);

    v.addBannedFragment('echo secret');
    expect(() => v.validate('echo secret')).toThrow(/banned fragment/i);
  });

  it('ignores empty custom bans', () => {
    const v = new CommandValidator();
    v.addBannedCommand('   ', 'ignored');
    v.addBannedFragment('   ');
    expect(() => v.validate('echo ok')).not.toThrow();
  });
});
