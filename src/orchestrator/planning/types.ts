import { randomUUID } from 'node:crypto';
import type { OrchestratorStep } from '../types.js';

export type GapStatus = 'open' | 'resolved' | 'blocked';

export interface Gap {
  id: string;
  description: string;
  createdAtMs: number;
  status: GapStatus;
  parentGapId?: string;
  tags?: string[];
}

export interface PlanNode {
  id: string;
  gapId: string;
  step: OrchestratorStep;
  createdAtMs: number;
}

/**
 * Minimal PlanningTree scaffold inspired by gap-driven agent loops.
 * - Tracks gaps (what we still need) and actions (steps) that attempt to close gaps.
 * - Keeps the implementation lightweight; the engine can progressively enhance scoring/branching later.
 */
export class PlanningTree {
  private readonly gaps = new Map<string, Gap>();
  private readonly nodes: PlanNode[] = [];
  readonly rootGapId: string;

  constructor(rootDescription: string) {
    const root: Gap = {
      id: `gap_${randomUUID()}`,
      description: rootDescription,
      createdAtMs: Date.now(),
      status: 'open'
    };
    this.rootGapId = root.id;
    this.gaps.set(root.id, root);
  }

  addGap(description: string, parentGapId?: string, tags?: string[]): Gap {
    const gap: Gap = {
      id: `gap_${randomUUID()}`,
      description,
      createdAtMs: Date.now(),
      status: 'open',
      parentGapId,
      tags
    };
    this.gaps.set(gap.id, gap);
    return gap;
  }

  resolveGap(gapId: string): void {
    const g = this.gaps.get(gapId);
    if (!g) return;
    g.status = 'resolved';
  }

  blockGap(gapId: string): void {
    const g = this.gaps.get(gapId);
    if (!g) return;
    g.status = 'blocked';
  }

  addStep(gapId: string, step: OrchestratorStep): PlanNode {
    const node: PlanNode = {
      id: `node_${randomUUID()}`,
      gapId,
      step,
      createdAtMs: Date.now()
    };
    this.nodes.push(node);
    return node;
  }

  getOpenGaps(): Gap[] {
    return Array.from(this.gaps.values()).filter((g) => g.status === 'open');
  }

  toPlan(): OrchestratorStep[] {
    return this.nodes.map((n) => n.step);
  }
}

