/**
 * glob.mjs — Lightweight glob pattern matcher.
 *
 * Supports:
 *   *       matches any sequence of characters (except /)
 *   ?       matches exactly one character
 *   [abc]   matches any character in the set
 *   [!abc]  matches any character not in the set
 *
 * Usage:
 *   globMatch('foo.js', '*.js')           // true
 *   globMatch('foo.test.js', '*.test.*')  // true
 *   globMatch('README.md', 'readme*')     // true (case-insensitive)
 */

/**
 * Convert a glob pattern to a RegExp.
 * @param {string} pattern
 * @param {boolean} [caseInsensitive=false]
 * @returns {RegExp}
 */
export function globToRegex(pattern, caseInsensitive = false) {
  let re = '';
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    if (ch === '*') {
      // ** not supported, just * matches everything except /
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      // character class
      let cls = '';
      i++; // skip [
      if (i < len && pattern[i] === '!') {
        cls += '^';
        i++;
      }
      while (i < len && pattern[i] !== ']') {
        cls += pattern[i] === '\\' ? pattern[++i] : pattern[i];
        i++;
      }
      i++; // skip ]
      re += `[${cls}]`;
    } else if (ch === '\\' && i + 1 < len) {
      re += escapeRegex(pattern[++i]);
      i++;
    } else {
      re += escapeRegex(ch);
      i++;
    }
  }

  const flags = caseInsensitive ? 'i' : '';
  return new RegExp(`^${re}$`, flags);
}

function escapeRegex(ch) {
  return ch.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Test if a filename matches a glob pattern (case-insensitive by default).
 * @param {string} filename
 * @param {string} pattern
 * @returns {boolean}
 */
export function globMatch(filename, pattern) {
  return globToRegex(pattern, true).test(filename);
}

/**
 * Test if a filename matches any of the comma-separated patterns.
 * @param {string} filename
 * @param {string} patternList  comma-separated glob patterns
 * @returns {boolean}
 */
export function globMatchAny(filename, patternList) {
  const patterns = patternList.split(',').map(p => p.trim()).filter(Boolean);
  return patterns.some(p => globMatch(filename, p));
}
