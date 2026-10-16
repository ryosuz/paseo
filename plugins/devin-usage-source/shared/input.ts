import { z } from "zod";
export const inputSchema = z.discriminatedUnion("store", [
  z
    .object({
      store: z.literal("env"),
      tokenEnv: z.string().min(1),
      orgEnv: z.string().min(1),
    })
    .strict(),
  z
    .object({
      store: z.literal("file"),
      credentialsPath: z.string().min(1),
      configPath: z.string().min(1),
    })
    .strict(),
]);
export type UsageInput = z.infer<typeof inputSchema>;
