declare module "express" {
  const express: any;
  export type Request = any;
  export type Response = any;
  export default express;
}

declare module "qrcode" {
  const qrcode: any;
  export default qrcode;
}

declare module "qrcode-terminal" {
  const qrcodeTerminal: any;
  export default qrcodeTerminal;
}

declare module "figlet" {
  const figlet: any;
  export default figlet;
}

declare var botName: string;
declare var botImage1: string;
declare var botImage2: string;
declare var botImage3: string;
declare var botImage4: string;
declare var botImage5: string;
declare var botImage6: string;
declare var botVideo: string;
declare var suppL: string;
declare var packname: string;
declare var author: string;
declare var prefa: string;
declare var owner: string[];
declare var tenorApiKey: string;
declare var botVersion: string;
declare var updateAvailable: boolean;
declare var latestVersion: string;
declare var botDeletedMsgIds: Set<string>;
declare var lidToJidMap: Map<string, string>;
