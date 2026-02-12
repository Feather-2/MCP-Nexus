import { SkillDiffAnalyzer } from './SkillDiffAnalyzer.js';

function buildSkillFrontmatter(frontmatter: string): string {
  return [
    '---',
    frontmatter.trim(),
    '---',
    '',
    '# Demo Skill',
    '',
    'body'
  ].join('\n');
}

describe('SkillDiffAnalyzer', () => {
  const analyzer = new SkillDiffAnalyzer();

  it('detects changes and flags risks', () => {
    const oldContent = buildSkillFrontmatter(`
capabilities:
  filesystem:
    read:
      - /workspace
    write: []
tools:
  - read_file
`);

    const newContent = buildSkillFrontmatter(`
capabilities:
  filesystem:
    read:
      - /workspace
    write:
      - /workspace/out
tools:
  - read_file
  - shell_exec
`);

    const riskFlags = analyzer.analyzeDiff(oldContent, newContent);

    expect(riskFlags.length).toBeGreaterThan(0);
    expect(riskFlags.every((flag) => ['critical', 'high', 'medium', 'low'].includes(flag.severity))).toBe(true);
    expect(riskFlags.every((flag) => typeof flag.isEscalation === 'boolean')).toBe(true);
  });

  it('marks restrictive changes with lower severity', () => {
    const oldContent = buildSkillFrontmatter(`
capabilities:
  filesystem:
    read:
      - /workspace
      - /workspace/private
    write:
      - /workspace/out
  network:
    allowedHosts:
      - api.example.com
      - internal.example.com
    allowedPorts:
      - 443
  subprocess:
    allowed: true
    allowedCommands:
      - bash
      - node
tools:
  - read_file
  - shell_exec
commands:
  - npm test
  - npm run build
`);

    const newContent = buildSkillFrontmatter(`
capabilities:
  filesystem:
    read:
      - /workspace
    write: []
  network:
    allowedHosts:
      - api.example.com
    allowedPorts:
      - 443
  subprocess:
    allowed: false
    allowedCommands: []
tools:
  - read_file
commands:
  - npm test
`);

    const riskFlags = analyzer.analyzeDiff(oldContent, newContent);

    expect(riskFlags.length).toBeGreaterThan(0);
    expect(riskFlags.every((flag) => flag.severity === 'low' || flag.severity === 'medium')).toBe(true);
    expect(riskFlags.every((flag) => !flag.isEscalation)).toBe(true);
  });

  it('returns empty array when content is identical', () => {
    const content = buildSkillFrontmatter(`
capabilities:
  filesystem:
    read: ["/workspace"]
    write: []
`);

    const riskFlags = analyzer.analyzeDiff(content, content);
    expect(riskFlags).toEqual([]);
  });
});
