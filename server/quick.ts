/**
 * Messages that want a quick word back and nothing else: a hello, a thank-you,
 * "this is just a test".
 *
 * Such a turn used to cost the same as a job. Agent mode planned first (a
 * `set_mode` round before anything was said), the model thought before each
 * round, and when the message named a colleague the lead took one more round
 * afterwards to retell what the colleague had already said. A greeting took
 * most of a minute and cost real money.
 *
 * The list is deliberately narrow. A word that can also mean "go ahead" (ok,
 * yes, sure, do it, great) is never here: answering that quickly would drop
 * the work it was asking for. A message that is wrongly missed is only slow
 * the way it always was; one wrongly caught would be answered without a plan.
 */

const SMALL_TALK: readonly RegExp[] = [
  /^(hi|hello|hey|hiya|howdy|yo|sup|heya)( (there|again|everyone|all|team|folks|friend))?$/,
  /^good (morning|afternoon|evening|night)( (everyone|all|team))?$/,
  /^(what'?s up|whats up|how are you|how are you doing|how'?s it going|how is it going|how'?s everything)$/,
  /^(just )?(saying|say|wanted to say|came to say) (hi|hello|hey)( there)?$/,
  /^(this is )?(just )?(a |an )?(quick )?(test|testing|ping|sanity check)( (message|ping|only|please))?$/,
  /^(thanks|thank you|thx|ty|cheers)( (so much|a lot|very much|again|everyone|all|team))?$/,
  /^(never ?mind|nvm|no worries|all good)$/,
];

/** What is left of a message once @names, punctuation and emoji are gone. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[^\w@.])@[\w-]+/g, " ")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether the whole of a message is small talk. A message that names a colleague still counts: it is the rest that is read. */
export function isSmallTalk(text: string): boolean {
  const said = plain(String(text ?? ""));
  if (!said || said.length > 60) return false;
  return SMALL_TALK.some((pattern) => pattern.test(said));
}
