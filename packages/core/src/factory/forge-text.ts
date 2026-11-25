/**
 * Agent-written text is posted to the forge with the factory's token, so the
 * forge acts on it as if the token's owner wrote it. Three things must not survive:
 *
 * - images and raw HTML: the forge fetches an image URL when the page renders, which lets an agent
 *   send data out through its own summary even with no network of its own;
 * - `@mentions`: they notify whoever owns that login;
 * - `#123` references and closing keywords next to them: merging would close unrelated issues.
 *
 * Code spans and fenced blocks are left alone: the forge renders them inert.
 */
export function forgeSafe(text: string): string {
  // odd segments are code (fenced blocks first, then inline spans)
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : neutralize(part)))
    .join('')
}

const neutralize = (s: string) =>
  s
    // image → plain link text: nothing is fetched until a human clicks
    .replace(/!\[/g, '[')
    // raw HTML tags (<img>, <a>, comments) render as text
    .replace(/<(?=[A-Za-z/!])/g, '&lt;')
    // a mention in a code span notifies nobody
    .replace(/(^|[^\w`/.])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_-]+)?)/g, '$1`@$2`')
    // an issue reference in a code span links and closes nothing
    .replace(/(^|[^\w`&])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g, '$1`$2`')
