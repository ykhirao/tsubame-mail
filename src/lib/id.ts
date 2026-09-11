import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const raw = customAlphabet(alphabet, 21);

export const idPrefixes = {
	user: "usr",
	session: "ses",
	apiKey: "key",
	domain: "dom",
	address: "adr",
	thread: "thr",
	message: "msg",
	attachment: "att",
	rule: "rul",
	job: "job",
	webhook: "whk",
	delivery: "dlv",
	audit: "aud",
	device: "dev",
	notificationRule: "nrl",
	notification: "ntf",
	digest: "dig",
} as const;

export type IdKind = keyof typeof idPrefixes;

export function newId(kind: IdKind): string {
	return `${idPrefixes[kind]}_${raw()}`;
}
