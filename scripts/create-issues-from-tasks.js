#!/usr/bin/env node
/*
Create GitHub milestones and issues from docs/TASKS.md.

Requirements:
  - GitHub CLI installed and authenticated: https://cli.github.com/
  - Run from repo root (or pass --repo owner/repo)

Usage:
  node scripts/create-issues-from-tasks.js --dry-run
  node scripts/create-issues-from-tasks.js --repo owner/repo
*/

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const repoArgIdx = args.indexOf('--repo');
const explicitRepo = repoArgIdx !== -1 ? args[repoArgIdx + 1] : undefined;

function sh(cmd) {
  return cp.execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function trySh(cmd) {
  try { return sh(cmd); } catch { return ''; }
}

function detectRepo() {
  if (explicitRepo) return explicitRepo;
  const url = trySh('git remote get-url origin');
  if (!url) throw new Error('Cannot detect repo. Pass --repo owner/repo');
  // Support HTTPS and SSH
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  const httpsMatch = url.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/);
  if (!httpsMatch) throw new Error(`Unsupported origin URL: ${url}`);
  return `${httpsMatch[1]}/${httpsMatch[2]}`;
}

function ensureGh() {
  try { sh('gh --version'); } catch {
    throw new Error('GitHub CLI not found. Install gh: https://cli.github.com/');
  }
}

function readTasks() {
  const file = path.resolve(__dirname, '../docs/TASKS.md');
  if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);
  return fs.readFileSync(file, 'utf-8');
}

function parseTasks(md) {
  // Extract stages and subtasks
  // Stage heading like: ## 阶段 2：专业化与容器沙盒
  // Subsection like: ### 2.1 模板编辑页：...
  // Task like: - [ ] 内容
  const lines = md.split(/\r?\n/);
  const stages = [];
  let currentStage = null;
  let currentSection = null;

  for (const line of lines) {
    const stageMatch = line.match(/^##\s*阶段\s*(\d+)\s*：(.+)$/);
    if (stageMatch) {
      currentStage = {
        stageNo: stageMatch[1],
        title: stageMatch[2].trim(),
        sections: []
      };
      stages.push(currentStage);
      currentSection = null;
      continue;
    }

    const sectionMatch = line.match(/^###\s*([\d\.]+)\s*(.+)$/);
    if (sectionMatch && currentStage) {
      currentSection = {
        key: sectionMatch[1].trim(),
        title: sectionMatch[2].trim(),
        tasks: []
      };
      currentStage.sections.push(currentSection);
      continue;
    }

    const taskMatch = line.match(/^\s*-\s*\[\s*\]\s*(.+)$/);
    if (taskMatch && currentSection) {
      currentSection.tasks.push(taskMatch[1].trim());
    }
  }
  return stages;
}

function createMilestone(repo, title) {
  if (isDryRun) return console.log(`[dry-run] gh milestone create -R ${repo} ${title}`);
  trySh(`gh milestone create -R ${repo} --title "${title}"`);
}

function ensureMilestones(repo) {
  // From ROADMAP.md
  const milestones = ['M1 核心闭环', 'M2 容器沙盒上线', 'M3 Windows 安装包 GA'];
  const list = trySh(`gh api -R ${repo} repos/${repo}/milestones?state=all`);
  const existing = list ? JSON.parse(list).map(m => m.title) : [];
  for (const m of milestones) {
    if (!existing.includes(m)) createMilestone(repo, m);
  }
}

function milestoneForStage(stageNo) {
  if (stageNo === '1') return 'M1 核心闭环';
  if (stageNo === '2') return 'M2 容器沙盒上线';
  return 'M3 Windows 安装包 GA';
}

function ensureLabel(repo, name, color = '0e8a16', desc = '') {
  const labels = trySh(`gh label list -R ${repo} --json name | jq -r '.[].name'`);
  const exists = labels && labels.split('\n').includes(name);
  if (exists) return;
  const cmd = `gh label create -R ${repo} "${name}" --color ${color} ${desc ? `--description "${desc}"` : ''}`;
  if (isDryRun) console.log('[dry-run]', cmd); else trySh(cmd);
}

function createIssue(repo, stage, section, task) {
  const title = `[阶段${stage.stageNo}] ${section.title} · ${task.replace(/`/g, '')}`.slice(0, 120);
  const body = [
    `阶段：${stage.stageNo} - ${stage.title}`,
    `子任务：${section.key} ${section.title}`,
    '',
    '任务描述：',
    task,
    '',
    '验收：',
    '- 符合 PRD 对应条目，UI 有明确错误提示；',
    '- 通过基本 e2e 手工验证；',
    '',
    '参考：',
    '- docs/PRODUCT_REQUIREMENTS.md',
    '- docs/ROADMAP.md',
    '- docs/TASKS.md'
  ].join('\n');

  const milestone = milestoneForStage(stage.stageNo);
  const labels = [`stage:${stage.stageNo}`, 'type:enhancement'];
  const cmd = `gh issue create -R ${repo} -t "${title}" -b "${body}" -m "${milestone}" ${labels.map(l=>`-l "${l}"`).join(' ')}`;
  if (isDryRun) console.log('[dry-run]', cmd); else trySh(cmd);
}

function main() {
  ensureGh();
  const repo = detectRepo();
  const md = readTasks();
  const stages = parseTasks(md);

  ensureLabel(repo, 'type:enhancement', '1d76db', 'Feature work');
  ensureLabel(repo, 'stage:1', '5319e7');
  ensureLabel(repo, 'stage:2', '0e8a16');
  ensureLabel(repo, 'stage:3', 'fbca04');
  ensureMilestones(repo);

  for (const stage of stages) {
    for (const section of stage.sections) {
      for (const task of section.tasks) {
        createIssue(repo, stage, section, task);
      }
    }
  }

  console.log('Done.');
}

main();


