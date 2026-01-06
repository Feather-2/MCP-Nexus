// Command validation
export {
  CommandValidator,
  DEFAULT_BANNED_COMMANDS,
  DEFAULT_BANNED_FRAGMENTS,
  type ValidatorOptions
} from './command-validator.js';

// Hard rule engine
export { HardRuleEngine, type HardRuleEvaluation } from './HardRuleEngine.js';

// Rules
export { checkCommand, DEFAULT_COMMAND_BLACKLIST, type CommandCheckResult } from './rules/CommandBlacklist.js';
export { checkSignature, DEFAULT_MALWARE_SIGNATURES, type SignatureCheckResult } from './rules/MalwareSignatures.js';

// Canary system
export {
  setupCanaries,
  checkCanaryAccess,
  type CanaryCheckResult,
  type CanarySetup,
  type CanarySetupEntry
} from './CanarySystem.js';

// Capability manifest
export {
  type SkillCapabilities,
  type FilesystemCapabilities,
  type NetworkCapabilities,
  type SubprocessCapabilities,
  type ResourceCapabilities,
  DEFAULT_SKILL_CAPABILITIES,
  validateCapabilities,
  mergeWithDefaults
} from './CapabilityManifest.js';

// Risk scoring types
export { type RiskDecision, type RiskSignal, type ScoringResult } from './types.js';

// Risk scorer
export { RiskScorer } from './RiskScorer.js';

// Audit pipeline
export {
  AuditPipeline,
  type AuditResult,
  type AuditFinding,
  type AuditFindingSeverity,
  type AuditPipelineOptions,
  type HardRuleAnalyzer,
  type EntropyAnalyzer as EntropyAnalyzerInterface,
  type PermissionAnalyzer as PermissionAnalyzerInterface,
  type AiAnalyzer,
  type BehaviorAnalyzer,
  type RiskScorer as RiskScorerInterface
} from './AuditPipeline.js';

// AI auditor
export {
  AiAuditor,
  type AiAuditResult,
  type AiFinding,
  type AiFindingSeverity,
  type AiAuditorOptions
} from './AiAuditor.js';

// Behavior validator
export {
  BehaviorValidator,
  type BehaviorValidationResult,
  type Violation,
  type ViolationSeverity,
  type ExecutionTrace
} from './BehaviorValidator.js';

// Analyzers
export { EntropyAnalyzer, type EntropyResult } from './analyzers/EntropyAnalyzer.js';
export { PermissionAnalyzer, type PermissionAnalysisResult } from './analyzers/PermissionAnalyzer.js';
export {
  DependencyAuditor,
  type DependencyAuditResult,
  type DependencyVulnerability
} from './analyzers/DependencyAuditor.js';

// Executable resolver
export { ExecutableResolver, type ExecutableResolverOptions } from './ExecutableResolver.js';

// Sandbox policy
export { applyGatewaySandboxPolicy, type ApplyGatewaySandboxPolicyResult } from './SandboxPolicy.js';

// Secrets utilities
export { isEnvRef, extractEnvRefName, isSensitiveKey, maskSecret, redactEnv, redactMcpServiceConfig, findPlaintextSecrets, assertNoPlaintextSecrets, resolveEnvRefs, resolveArgsEnvRefs, resolveMcpServiceConfigEnvRefs } from './secrets.js';
