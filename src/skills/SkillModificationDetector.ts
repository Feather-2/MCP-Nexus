import crypto from 'crypto';
import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';

export interface SkillModificationDetectorOptions {
  signatureSecret?: string;
}

export interface SkillDiffLine {
  type: 'added' | 'removed';
  line: number;
  content: string;
}

export interface SkillContentDiff {
  before: string;
  after: string;
  lines: SkillDiffLine[];
}

export interface SkillModificationSummary {
  changedFields: string[];
  addedFields: string[];
  removedFields: string[];
  bodyChanged: boolean;
}

export interface SkillModificationDetectionResult {
  isModified: boolean;
  skillMdPath: string;
  reason:
    | 'missing_file'
    | 'missing_signature'
    | 'missing_secret'
    | 'invalid_signature'
    | 'signature_valid'
    | 'signature_mismatch';
  fileHash?: string;
  skillName?: string;
  diff?: SkillContentDiff;
  summary?: SkillModificationSummary;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHexSignature(value: string): string {
  const trimmed = value.trim().replace(/^sha256[:=]/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error('Skill signature must be a 64-char SHA-256 hex string');
  }
  return trimmed;
}

function stripSignatureField(frontmatter: unknown): Record<string, unknown> {
  if (!isPlainObject(frontmatter)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'signature') continue;
    out[key] = value;
  }
  return out;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function buildSignaturePayload(frontmatter: unknown, body: string): string {
  return JSON.stringify({
    frontmatter: canonicalize(stripSignatureField(frontmatter)),
    body: body.replace(/\r\n/g, '\n')
  });
}

function computeSkillSignature(frontmatter: unknown, body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(buildSignaturePayload(frontmatter, body), 'utf8').digest('hex');
}

function safeHexEqual(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch (_error) {
    return false;
  }
}

function parseSkillMarkdown(content: string): { frontmatter: unknown; body: string } {
  if (!content.startsWith('---')) {
    return { frontmatter: {}, body: content.trimStart() };
  }

  const lines = content.split(/\r?\n/);
  if (lines.length < 3) return { frontmatter: {}, body: content.trimStart() };
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: content.trimStart() };

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) return { frontmatter: {}, body: content.trimStart() };

  const yamlText = lines.slice(1, end).join('\n');
  const rest = lines.slice(end + 1).join('\n');
  const frontmatter = yamlText.trim().length ? (parseYaml(yamlText) as unknown) : {};
  return { frontmatter, body: rest.trimStart() };
}

function flattenFields(prefix: string, value: unknown, out: Record<string, string>): void {
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out[prefix] = '{}';
      return;
    }
    for (const key of keys) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      flattenFields(childPrefix, value[key], out);
    }
    return;
  }

  out[prefix] = JSON.stringify(value);
}

function summarizeFieldChanges(beforeFrontmatter: unknown, afterFrontmatter: unknown, beforeBody: string, afterBody: string): SkillModificationSummary {
  const beforeMap: Record<string, string> = {};
  const afterMap: Record<string, string> = {};

  const beforeObject = isPlainObject(beforeFrontmatter) ? beforeFrontmatter : {};
  const afterObject = isPlainObject(afterFrontmatter) ? afterFrontmatter : {};

  for (const [key, value] of Object.entries(beforeObject)) {
    if (key === 'signature') continue;
    flattenFields(key, value, beforeMap);
  }
  for (const [key, value] of Object.entries(afterObject)) {
    if (key === 'signature') continue;
    flattenFields(key, value, afterMap);
  }

  const addedFields: string[] = [];
  const removedFields: string[] = [];
  const changedFields: string[] = [];

  const allKeys = new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)]);
  for (const key of allKeys) {
    const before = beforeMap[key];
    const after = afterMap[key];

    if (before === undefined && after !== undefined) {
      addedFields.push(key);
      continue;
    }
    if (before !== undefined && after === undefined) {
      removedFields.push(key);
      continue;
    }
    if (before !== after) {
      changedFields.push(key);
    }
  }

  const bodyChanged = beforeBody.replace(/\r\n/g, '\n') !== afterBody.replace(/\r\n/g, '\n');
  if (bodyChanged) changedFields.push('body');

  return {
    changedFields: [...new Set(changedFields)].sort(),
    addedFields: addedFields.sort(),
    removedFields: removedFields.sort(),
    bodyChanged
  };
}

export class SkillModificationDetector {
  private readonly signatureSecret?: string;

  constructor(options?: SkillModificationDetectorOptions) {
    this.signatureSecret = options?.signatureSecret ?? process.env.SKILL_SIGNATURE_SECRET;
  }

  diff(before: string, after: string): SkillContentDiff {
    const beforeNormalized = before.replace(/\r\n/g, '\n');
    const afterNormalized = after.replace(/\r\n/g, '\n');
    const beforeLines = beforeNormalized.split('\n');
    const afterLines = afterNormalized.split('\n');

    const max = Math.max(beforeLines.length, afterLines.length);
    const lines: SkillDiffLine[] = [];
    for (let index = 0; index < max; index += 1) {
      const beforeLine = beforeLines[index];
      const afterLine = afterLines[index];
      if (beforeLine === afterLine) continue;
      if (beforeLine !== undefined) {
        lines.push({ type: 'removed', line: index + 1, content: beforeLine });
      }
      if (afterLine !== undefined) {
        lines.push({ type: 'added', line: index + 1, content: afterLine });
      }
    }

    return {
      before: beforeNormalized,
      after: afterNormalized,
      lines
    };
  }

  summarize(before: string, after: string): SkillModificationSummary {
    const beforeParsed = parseSkillMarkdown(before);
    const afterParsed = parseSkillMarkdown(after);
    return summarizeFieldChanges(beforeParsed.frontmatter, afterParsed.frontmatter, beforeParsed.body, afterParsed.body);
  }

  async detectModification(skillMdPath: string, previousContent?: string): Promise<SkillModificationDetectionResult> {
    try {
      await access(skillMdPath, constants.F_OK);
    } catch (_error) {
      return {
        isModified: false,
        skillMdPath,
        reason: 'missing_file'
      };
    }

    const raw = await readFile(skillMdPath, 'utf8');
    const fileHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const { frontmatter, body } = parseSkillMarkdown(raw);
    const skillName = isPlainObject(frontmatter) && typeof frontmatter['name'] === 'string'
      ? frontmatter['name']
      : undefined;

    const signatureRaw = isPlainObject(frontmatter) ? frontmatter['signature'] : undefined;
    if (typeof signatureRaw !== 'string' || signatureRaw.trim().length === 0) {
      return {
        isModified: false,
        skillMdPath,
        reason: 'missing_signature',
        fileHash,
        skillName
      };
    }

    if (!this.signatureSecret) {
      return {
        isModified: false,
        skillMdPath,
        reason: 'missing_secret',
        fileHash,
        skillName
      };
    }

    let provided: string;
    try {
      provided = normalizeHexSignature(signatureRaw);
    } catch (_error) {
      return {
        isModified: false,
        skillMdPath,
        reason: 'invalid_signature',
        fileHash,
        skillName
      };
    }

    const expected = computeSkillSignature(frontmatter, body, this.signatureSecret);
    if (safeHexEqual(expected, provided)) {
      return {
        isModified: false,
        skillMdPath,
        reason: 'signature_valid',
        fileHash,
        skillName
      };
    }

    const baseline = previousContent ?? '';
    return {
      isModified: true,
      skillMdPath,
      reason: 'signature_mismatch',
      fileHash,
      skillName,
      diff: this.diff(baseline, raw),
      summary: this.summarize(baseline, raw)
    };
  }
}
