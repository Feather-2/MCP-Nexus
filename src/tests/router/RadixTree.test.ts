import { RadixTree } from '../../router/RadixTree.js';

describe('RadixTree', () => {
  it('supports exact matches', () => {
    const tree = new RadixTree<string>();
    tree.insert('/api/users', 'exact-users');

    expect(tree.match('/api/users')).toEqual(['exact-users']);
    expect(tree.match('/api/users/123')).toEqual([]);
    expect(tree.findLongestPrefix('/api/users')).toEqual(['exact-users']);
    expect(tree.findLongestPrefix('/api/users/123')).toEqual([]);
  });

  it('supports wildcard prefix matches and longest prefix', () => {
    const tree = new RadixTree<string>();
    tree.insert('/api/*', 'api');
    tree.insert('/api/users/*', 'users');

    expect(tree.match('/api/users/123')).toEqual(expect.arrayContaining(['api', 'users']));
    expect(tree.findLongestPrefix('/api/users/123')).toEqual(['users']);

    expect(tree.match('/api/health')).toEqual(['api']);
    expect(tree.findLongestPrefix('/api/health')).toEqual(['api']);
  });

  it('supports catch-all "*" and prefers exact over wildcard', () => {
    const tree = new RadixTree<string>();
    tree.insert('*', 'all');
    tree.insert('/a*', 'a-wild');
    tree.insert('/a', 'a-exact');

    expect(tree.match('/zzz')).toEqual(['all']);

    expect(tree.match('/a')).toEqual(expect.arrayContaining(['all', 'a-wild', 'a-exact']));
    expect(tree.findLongestPrefix('/a')).toEqual(['a-exact']);
    expect(tree.findLongestPrefix('/a/child')).toEqual(['a-wild']);
  });

  it('splits edges when inserting overlapping keys', () => {
    const tree = new RadixTree<string>();
    tree.insert('/abc', 'abc');
    tree.insert('/ab', 'ab');
    tree.insert('/abef', 'abef');

    expect(tree.match('/ab')).toEqual(['ab']);
    expect(tree.match('/abc')).toEqual(['abc']);
    expect(tree.match('/abef')).toEqual(['abef']);
  });

  it('supports the empty key at the root', () => {
    const tree = new RadixTree<string>();
    tree.insert('', 'root-exact');
    expect(tree.match('')).toEqual(['root-exact']);
    expect(tree.findLongestPrefix('')).toEqual(['root-exact']);
  });
});
