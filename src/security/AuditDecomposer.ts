import path from 'path';
import type { Skill } from '../skills/types.js';

export type SemanticUnitType =
  | 'tool_definitions'
  | 'parameter_schemas'
  | 'code_blocks'
  | 'data_flows'
  | 'imports';

export interface SemanticUnit {
  type: SemanticUnitType;
  content: string;
  location: string;
  metadata?: Record<string, unknown>;
}

export interface DecompositionResult {
  units: SemanticUnit[];
  summary: string;
}

interface ExtractedBlock {
  language: string;
  content: string;
  location: string;
  source: string;
  startLine: number;
}

const SCHEMA_LANGUAGES = new Set(['json', 'yaml', 'yml']);
const SUPPORT_CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.json', '.yaml', '.yml'
]);

function parseAllowedTools(value: string): string[] {
  return value
    .split(/[, \n\r\t]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function lineAt(content: string, offset: number): number {
  if (offset <= 0) return 1;
  return content.slice(0, offset).split('\n').length;
}

function sourceFromLocation(location: string): string {
  const [source] = location.split(':line:');
  return source || location;
}

function startLineFromLocation(location: string): number {
  const [, value] = location.split(':line:');
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function withLineOffset(location: string, offset: number): string {
  const source = sourceFromLocation(location);
  const startLine = startLineFromLocation(location);
  return `${source}:line:${startLine + offset}`;
}

function extractFencedBlocks(content: string, source: string): ExtractedBlock[] {
  const regex = /```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
  const blocks: ExtractedBlock[] = [];

  for (const match of content.matchAll(regex)) {
    const start = match.index ?? 0;
    const body = (match[2] ?? '').trim();
    if (!body) continue;
    const language = (match[1] ?? '').trim().toLowerCase();
    const startLine = lineAt(content, start);
    blocks.push({
      language,
      content: body,
      location: `${source}:line:${startLine}`,
      source,
      startLine
    });
  }

  return blocks;
}

function fallbackSupportBlock(relativePath: string, content: string): ExtractedBlock | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!SUPPORT_CODE_EXTENSIONS.has(ext)) return null;
  const language = ext.replace('.', '').toLowerCase();
  return {
    language,
    content,
    location: `supportFiles:${relativePath}:line:1`,
    source: `supportFiles:${relativePath}`,
    startLine: 1
  };
}

function extractImportTarget(line: string): string | undefined {
  const fromMatch = line.match(/\bfrom\s+['"]([^'"]+)['"]/i);
  if (fromMatch?.[1]) return fromMatch[1];

  const requireMatch = line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (requireMatch?.[1]) return requireMatch[1];

  const importMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/i);
  if (importMatch?.[1]) return importMatch[1];

  return undefined;
}

function extractToolUnits(skill: Skill): SemanticUnit[] {
  const units: SemanticUnit[] = [];
  const body = typeof skill?.body === 'string' ? skill.body : '';
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!/^#{2,3}\s*tool\b/i.test(line)) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,6}\s+\S/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
    }

    const content = lines.slice(i, end).join('\n').trim();
    if (!content) continue;
    units.push({ type: 'tool_definitions', content, location: `body:line:${i + 1}` });
  }

  const allowedTools = skill?.metadata?.allowedTools?.trim();
  if (allowedTools) {
    units.push({
      type: 'tool_definitions',
      content: `allowedTools: ${allowedTools}`,
      location: 'metadata:allowedTools',
      metadata: { tools: parseAllowedTools(allowedTools) }
    });
  }

  return units;
}

function detectDataFlows(codeUnits: SemanticUnit[]): SemanticUnit[] {
  const patterns: Array<{ type: string; regex: RegExp }> = [
    { type: 'network', regex: /\b(fetch\s*\(|axios\.[\w$]+\s*\(|https?:\/\/|request\s*\(|curl\s+)/i },
    { type: 'env', regex: /\bprocess\.env(?:\.[A-Z0-9_]+|\[['"][^'"]+['"]\])/i },
    { type: 'file_io', regex: /\bfs\.(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/i }
  ];

  const units: SemanticUnit[] = [];
  for (const block of codeUnits) {
    const lines = block.content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const trimmed = line.trim();
      if (!trimmed) continue;

      for (const pattern of patterns) {
        if (!pattern.regex.test(trimmed)) continue;
        units.push({
          type: 'data_flows',
          content: trimmed,
          location: withLineOffset(block.location, index),
          metadata: { kind: pattern.type }
        });
      }
    }
  }
  return units;
}

function detectImports(codeUnits: SemanticUnit[]): SemanticUnit[] {
  const importRegex = /^\s*import\s+.+$|^\s*from\s+['"][^'"]+['"]|\brequire\(\s*['"][^'"]+['"]\s*\)/i;
  const units: SemanticUnit[] = [];

  for (const block of codeUnits) {
    const lines = block.content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (!importRegex.test(line)) continue;
      const content = line.trim();
      if (!content) continue;
      units.push({
        type: 'imports',
        content,
        location: withLineOffset(block.location, index),
        metadata: { target: extractImportTarget(content) }
      });
    }
  }

  return units;
}

function buildSummary(units: SemanticUnit[]): string {
  const count = (type: SemanticUnitType) => units.filter((unit) => unit.type === type).length;
  return [
    `${count('tool_definitions')} tool definitions`,
    `${count('parameter_schemas')} parameter schemas`,
    `${count('code_blocks')} code blocks`,
    `${count('data_flows')} data flows`,
    `${count('imports')} imports`
  ].join(', ');
}

export class AuditDecomposer {
  decompose(skill: Skill): DecompositionResult {
    const units: SemanticUnit[] = [];
    units.push(...extractToolUnits(skill));

    const sources: Array<{ source: string; content: string; supportPath?: string }> = [];
    sources.push({ source: 'body', content: typeof skill?.body === 'string' ? skill.body : '' });

    if (skill?.supportFiles) {
      for (const [relativePath, content] of skill.supportFiles.entries()) {
        sources.push({ source: `supportFiles:${relativePath}`, content, supportPath: relativePath });
      }
    }

    const codeUnits: SemanticUnit[] = [];
    for (const source of sources) {
      const blocks = extractFencedBlocks(source.content, source.source);
      if (blocks.length === 0 && source.supportPath) {
        const fallback = fallbackSupportBlock(source.supportPath, source.content);
        if (fallback) blocks.push(fallback);
      }

      for (const block of blocks) {
        const metadata: Record<string, unknown> = { source: block.source, startLine: block.startLine };
        if (block.language) metadata.language = block.language;

        codeUnits.push({
          type: 'code_blocks',
          content: block.content,
          location: block.location,
          metadata
        });

        if (SCHEMA_LANGUAGES.has(block.language)) {
          units.push({
            type: 'parameter_schemas',
            content: block.content,
            location: block.location,
            metadata: { language: block.language }
          });
        }
      }
    }

    units.push(...codeUnits);
    units.push(...detectDataFlows(codeUnits));
    units.push(...detectImports(codeUnits));

    return {
      units,
      summary: buildSummary(units)
    };
  }
}
