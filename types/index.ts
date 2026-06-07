export interface AtlasClient {
    sendMessage: (from: string, content: any, options?: any) => Promise<any>;
    decodeJid: (jid: string) => Promise<string>;
    groupMetadata: (jid: string) => Promise<any>;
    [key: string]: any;
}

export interface QuotedMessage {
    sender?: string;
    id?: string;
    type?: string;
    caption?: string;
    download: () => Promise<Buffer>;
    text?: string;
}

export interface WAMessage {
    isGroup: boolean;
    sender?: string;
    pushName?: string;
    reply: (text: string | Buffer, chatId?: string, options?: any) => Promise<any>;
    quoted?: QuotedMessage | null;
    from: string;
    key: any;
}