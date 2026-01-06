import type { Skill } from '../skills/types.js';
import { checkCommand } from './rules/CommandBlacklist.js';
import { checkSignature } from './rules/MalwareSignatures.js';

export interface HardRuleEvaluation {
  rejected: boolean;
  reason?: string;
}

interface EvaluationSource {
  label: string;
  content: string;
}

function collectSources(skill: Skill): EvaluationSource[] {
  const sources: EvaluationSource[] = [
    { label: 'skill.body', content: skill.body },
    { label: 'skill.metadata', content: `${skill.metadata.name}\n${skill.metadata.description}` }
  ];

  if (skill.supportFiles) {
    for (const [relativePath, content] of skill.supportFiles.entries()) {
      sources.push({ label: `skill.supportFiles:${relativePath}`, content });
    }
  }

  return sources;
}

export class HardRuleEngine {
  evaluate(skill: Skill): HardRuleEvaluation {
    const sources = collectSources(skill);

    for (const source of sources) {
      const result = checkCommand(source.content);
      if (result.blocked) {
        return {
          rejected: true,
          reason: `CommandBlacklist matched "${result.pattern}" in ${source.label}`
        };
      }
    }

    for (const source of sources) {
      const result = checkSignature(source.content);
      if (result.matched) {
        return {
          rejected: true,
          reason: `MalwareSignatures matched "${result.signature}" in ${source.label}`
        };
      }
    }

    return { rejected: false };
  }
}
