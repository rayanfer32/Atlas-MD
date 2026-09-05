import { checkWelcome } from "./MongoDB/MongoDb_Core.js";

export interface ParticipantUpdate {
  id: string;
  author?: string;
  participants: (string | { id: string; lid?: string })[];
  action: "add" | "remove" | "promote" | "demote";
}

export default async (Atlas: any, anu: ParticipantUpdate): Promise<void> => {
  try {
    const metadata = await Atlas.groupMetadata(anu.id);
    const participants = anu.participants;
    let desc = metadata?.desc;
    if (desc === undefined) desc = "No Description";

    for (const numEntry of participants) {
      // Baileys v7 returns participants as objects {id, lid} instead of plain strings
      const num = typeof numEntry === "string" ? numEntry : numEntry.id;
      let ppuser: string;
      try {
        ppuser = await Atlas.profilePictureUrl(num, "image");
      } catch {
        ppuser = "https://i.imgur.com/MClOeqe.jpeg";
      }

      if (anu.action === "add") {
        const WELstatus = await checkWelcome(anu.id);
        const WAuserName = num;

        const Atlastext = `
Hello @${WAuserName.split("@")[0]} Senpai,

Welcome to *${metadata?.subject || "our group"}*.

*🧣 Group Description 🧣*

${desc}

*Thank You.*
  `;
        if (WELstatus) {
          await Atlas.sendMessage(anu.id, {
            image: { url: ppuser },
            caption: Atlastext,
            mentions: [num],
          });
        }
      } else if (anu.action === "remove") {
        const WELstatus = await checkWelcome(anu.id);
        const WAuserName = num;

        const Atlastext = `
  @${WAuserName.split("@")[0]} Senpai left the group.
  `;
        if (WELstatus) {
          await Atlas.sendMessage(anu.id, {
            image: { url: ppuser },
            caption: Atlastext,
            mentions: [num],
          });
        }
      }
    }
  } catch (err) {
    console.error("[ EXCEPTION ]", err);
  }
};
