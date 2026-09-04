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
