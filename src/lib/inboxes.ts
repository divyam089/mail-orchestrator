/** The 15 Workspace inboxes. One service account, five tenants, three inboxes each. */
export const WORKSPACE_DOMAINS = [
  "usefigcel.com",
  "tryfigcel.com",
  "meetfigcel.com",
  "getfigcel.com",
  "hellofigcel.com",
] as const;

export type InboxSeed = {
  email: string;
  senderName: string;
};

export const INBOXES: readonly InboxSeed[] = [
  { email: "piyush.pandey@meetfigcel.com", senderName: "Piyush Pandey" },
  { email: "divyam@tryfigcel.com", senderName: "Divyam Maru" },
  { email: "piyush@tryfigcel.com", senderName: "Piyush Pandey" },
  { email: "divyam.maru@tryfigcel.com", senderName: "Divyam Maru" },
  { email: "divyam@usefigcel.com", senderName: "Divyam Maru" },
  { email: "piyush@usefigcel.com", senderName: "Piyush Pandey" },
  { email: "divyam.maru@usefigcel.com", senderName: "Divyam Maru" },
  { email: "piyush@getfigcel.com", senderName: "Piyush Pandey" },
  { email: "divyam.maru@getfigcel.com", senderName: "Divyam Maru" },
  { email: "divyam@hellofigcel.com", senderName: "Divyam Maru" },
  { email: "piyush@hellofigcel.com", senderName: "Piyush Pandey" },
  { email: "piyush.pandey@hellofigcel.com", senderName: "Piyush Pandey" },
  { email: "divyam@meetfigcel.com", senderName: "Divyam Maru" },
  { email: "piyush@meetfigcel.com", senderName: "Piyush Pandey" },
  { email: "divyam@getfigcel.com", senderName: "Divyam Maru" },
];

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}
