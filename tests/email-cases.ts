export type EmailCase = {
  input: string;
  literal: string | null;
  normalized: string | null;
};

export const EMAIL_CASES: EmailCase[] = [
  {
    input: "  John.Doe+sales@gmail.com  ",
    literal: "john.doe+sales@gmail.com",
    normalized: "johndoe@gmail.com",
  },
  { input: "johndoe@gmail.com", literal: "johndoe@gmail.com", normalized: "johndoe@gmail.com" },
  { input: "JOHNDOE@GMAIL.COM", literal: "johndoe@gmail.com", normalized: "johndoe@gmail.com" },
  { input: "j.o.h.n@gmail.com", literal: "j.o.h.n@gmail.com", normalized: "john@gmail.com" },
  {
    input: "john.doe+sales+extra@gmail.com",
    literal: "john.doe+sales+extra@gmail.com",
    normalized: "johndoe@gmail.com",
  },
  {
    input: "J.O.H.N+News@GoogleMail.com",
    literal: "j.o.h.n+news@googlemail.com",
    normalized: "john@gmail.com",
  },
  {
    input: "John.Doe@Company.com",
    literal: "john.doe@company.com",
    normalized: "john.doe@company.com",
  },
  {
    input: "john+tag@company.com",
    literal: "john+tag@company.com",
    normalized: "john+tag@company.com",
  },
  {
    input: "divyam.maru@usefigcel.com",
    literal: "divyam.maru@usefigcel.com",
    normalized: "divyam.maru@usefigcel.com",
  },
  {
    input: "divyammaru@usefigcel.com",
    literal: "divyammaru@usefigcel.com",
    normalized: "divyammaru@usefigcel.com",
  },
  {
    input: "Jane Doe <John.Doe+x@Gmail.com>",
    literal: "john.doe+x@gmail.com",
    normalized: "johndoe@gmail.com",
  },
  {
    input: "  Jane   <jane.smith+hi@gmail.com>  ",
    literal: "jane.smith+hi@gmail.com",
    normalized: "janesmith@gmail.com",
  },
  { input: "José <jose@x.com>", literal: "jose@x.com", normalized: "jose@x.com" },
  { input: "user@gmail.com.", literal: "user@gmail.com", normalized: "user@gmail.com" },
  { input: "john..doe@gmail.com", literal: "john..doe@gmail.com", normalized: "johndoe@gmail.com" },
  { input: ".john@gmail.com", literal: ".john@gmail.com", normalized: "john@gmail.com" },
  { input: "john..doe@company.com", literal: "john..doe@company.com", normalized: null },
  { input: "john.@company.com", literal: "john.@company.com", normalized: null },
  { input: "+tag@gmail.com", literal: "+tag@gmail.com", normalized: null },
  { input: "not-an-email", literal: null, normalized: null },
  { input: "a@b", literal: null, normalized: null },
  { input: "a@@b.com", literal: null, normalized: null },
  { input: "", literal: null, normalized: null },
  { input: "   ", literal: null, normalized: null },
  { input: "josé@x.com", literal: null, normalized: null },
  { input: "a@b.c", literal: null, normalized: null },
  { input: "john @gmail.com", literal: null, normalized: null },
  { input: '"Doe, Jane" <jane@x.co>', literal: "jane@x.co", normalized: "jane@x.co" },
];
