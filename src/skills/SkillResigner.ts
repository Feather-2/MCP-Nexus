import path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Logger } from '../types/index.js';
import { SkillLoader } from './SkillLoader.js';

export interface SkillResignerOptions {
  signatureSecret?: string;
  logger?: Logger;
}

export interface SkillResignResult {
  skillMdPath: string;
  skillName: string;
  signature: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSkillMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
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
  const parsed = yamlText.trim().length ? (parseYaml(yamlText) as unknown) : {};
  return { frontmatter: isPlainObject(parsed) ? { ...parsed } : {}, body: rest.trimStart() };
}

function composeSkillMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const normalizedBody = body.replace(/\r\n/g, '\n');
  const yamlText = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yamlText}\n---\n\n${normalizedBody}`;
}

export class SkillResigner {
  private readonly signatureSecret?: string;
  private readonly logger?: Logger;

  constructor(options?: SkillResignerOptions) {
    this.signatureSecret = options?.signatureSecret ?? process.env.SKILL_SIGNATURE_SECRET;
    this.logger = options?.logger;
  }

  async resign(skillMdPath: string): Promise<SkillResignResult> {
    if (!this.signatureSecret) {
      throw new Error('SKILL_SIGNATURE_SECRET is required for resign');
    }

    const absolutePath = path.resolve(skillMdPath);
    const raw = await readFile(absolutePath, 'utf8');
    const { frontmatter, body } = parseSkillMarkdown(raw);
    const signature = SkillLoader.computeSignature(frontmatter, body, this.signatureSecret);

    const nextFrontmatter: Record<string, unknown> = {
      ...frontmatter,
      signature
    };
    const nextMarkdown = composeSkillMarkdown(nextFrontmatter, body);
    await writeFile(absolutePath, nextMarkdown, 'utf8');

    const verifier = new SkillLoader({
      signatureSecret: this.signatureSecret,
      enforceSignatures: true,
      logger: this.logger
    });
    const loaded = await verifier.loadSkillFromSkillMd(absolutePath);
    if (!loaded) {
      throw new Error(`Resigned skill failed verification: ${absolutePath}`);
    }

    return {
      skillMdPath: absolutePath,
      skillName: loaded.metadata.name,
      signature
    };
  }
}
