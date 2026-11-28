// The decisions of the sign-in page, kept apart from the page so they can be
// checked on their own (supabase/tests/signin_web_test.ts).

/** What Supabase Auth reports when a request fails. */
export interface AuthFailure {
  message: string
  status?: number
  code?: string
}

/** A line under the form: plain, or a problem. */
export interface Note {
  text: string
  bad: boolean
}

/** The code as the server expects it: its digits, whatever was typed or pasted around them. */
export const cleanCode = (typed: string) => typed.replace(/\D/g, '')

const sentence = (words: string) => {
  const text = words.trim().replace(/\.$/, '')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

/**
 * After asking for a code: on to the code box, or stay on the email with the reason.
 * A request the server turns down for coming too soon (429) still leads to the code
 * box, because the code from the earlier email is the one that works.
 */
export function afterSend(error: AuthFailure | null, email: string): { toCode: boolean; note: Note } {
  if (!error) return { toCode: true, note: { text: `A code is on its way to ${email}.`, bad: false } }
  if (error.status === 429) {
    const text = `${sentence(error.message)} No new email was sent. If you already have a code, type it here.`
    return { toCode: true, note: { text, bad: false } }
  }
  const noAccount = /signups not allowed|not found|saving new user/i.test(error.message)
  const text = noAccount ? `There is no Nexus account for ${email}. Check the address for typos.` : error.message
  return { toCode: false, note: { text, bad: true } }
}

/** Why a typed code did not sign in. */
export function codeProblem(error: AuthFailure): Note {
  const stale = error.code === 'otp_expired' || /expired|invalid/i.test(error.message)
  const text = stale ? 'That code is wrong or has expired. Use the newest email, or send a new code.' : error.message
  return { text, bad: true }
}
