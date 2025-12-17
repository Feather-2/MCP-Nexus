import { ComplexityEvaluator } from '../../routing/complexity.js';

describe('ComplexityEvaluator', () => {
  const evaluator = new ComplexityEvaluator();

  it('scores a simple task (read file) as low complexity', () => {
    const result = evaluator.evaluate(
      'Read file, show file, list directory, get config, check status, print output.'
    );

    expect(result.score).toBeLessThan(25);
    expect(result.stepCount).toBeGreaterThanOrEqual(1);
    expect(result.toolCount).toBeGreaterThanOrEqual(1);
    expect(result.multiFile).toBe(false);
    expect(result.externalApi).toBe(false);
    expect(result.iterative).toBe(false);
  });

  it('scores a complex task (refactor, migrate) as high complexity', () => {
    const task = [
      'Refactor and migrate the architecture of the system across the repo.',
      'First analyze the current pipeline, then redesign the workflow.',
      'Step 1: implement the new integration layer.',
      'Step 2: optimize performance and benchmark results.',
      'Research best practice and compare alternatives.',
      '- validate backwards compatibility',
      '- update documentation',
      '- run tests'
    ].join('\n');

    const result = evaluator.evaluate(task);

    expect(result.score).toBeGreaterThan(80);
    expect(result.multiFile).toBe(true);
    expect(result.stepCount).toBeGreaterThanOrEqual(3);
  });

  it('detects multi-step phrasing (then/after/step) and estimates step count', () => {
    const result = evaluator.evaluate(
      'Do A then do B after that do C.'
    );

    expect(result.stepCount).toBe(3);
    expect(result.score).toBeGreaterThan(40);
  });

  it('adds structure points for bullet and numbered lists', () => {
    const noList = evaluator.evaluate('Implement X. Validate Y. Ship Z.');
    const withList = evaluator.evaluate(
      ['Implement X:', '- Validate Y', '- Ship Z', '1) Verify logs'].join('\n')
    );

    expect(withList.score).toBeGreaterThan(noList.score);
    expect(withList.stepCount).toBe(3);
  });

  it('estimateToolCount counts distinct tool indicators', () => {
    const result = evaluator.evaluate(
      [
        'Open file.',
        'Edit file.',
        'Search for TODO.',
        'Run tests.',
        'Git commit.',
        'Call API via fetch request over HTTP.',
        'Query database with SQL.',
        'Deploy via docker.'
      ].join(' ')
    );

    expect(result.toolCount).toBe(9);
  });

  it('detectMultiFile/externalApi/iterative boolean detection works', () => {
    const result = evaluator.evaluate(
      'Refactor across the codebase, rename throughout, call https://example.com API, repeat until stable.'
    );

    expect(result.multiFile).toBe(true);
    expect(result.externalApi).toBe(true);
    expect(result.iterative).toBe(true);
  });

  it('supports custom signals and custom weights', () => {
    const weighted = new ComplexityEvaluator({
      signals: { simpleKeywords: ['foo'] },
      keywordWeight: 1,
      patternWeight: 0,
      structureWeight: 0
    });

    expect(weighted.evaluate('foo').score).toBe(42);
    expect(evaluator.evaluate('foo').score).toBe(33);
  });

  it('adds structure points for very long tasks and code markers', () => {
    const longWithCode = [
      Array.from({ length: 60 }, () => 'word').join(' '),
      '```ts',
      'console.log(1)',
      '```'
    ].join('\n');

    const longWithoutCode = Array.from({ length: 60 }, () => 'word').join(' ');

    const withCode = evaluator.evaluate(longWithCode);
    const withoutCode = evaluator.evaluate(longWithoutCode);

    expect(withCode.score).toBeGreaterThan(withoutCode.score);
    expect(withCode.score).toBeGreaterThan(40);
  });
});
