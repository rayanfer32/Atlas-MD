import mongoose, { type Document, type Model } from "mongoose";
import config from "../../Configurations.js";

const options = {
  socketTimeoutMS: 30000,
};

// Atlas can work with up to 4 MongoDB databases at once to distribute DB load
const db1 = mongoose.createConnection((config as any).mongodb, options);
const db2 = mongoose.createConnection((config as any).mongodb, options);

export interface IGroupData extends Document {
  id: string;
  antilink: boolean;
  antidelete: boolean;
  nsfw: boolean;
  bangroup: boolean;
  chatBot: boolean;
  botSwitch: boolean;
  switchNSFW: boolean;
  switchWelcome: boolean;
}

export interface IUserData extends Document {
  id: string;
  ban: boolean;
  name?: string;
  addedMods: boolean;
}

export interface ISystemData extends Document {
  id: string;
  seletedCharacter: string;
  PMchatBot: boolean;
  botMode: string;
}

export interface IPluginData extends Document {
  plugin: string;
  url: string;
}

const GroupSchema = new mongoose.Schema<IGroupData>({
  id: { type: String, unique: true, required: true },
  antilink: { type: Boolean, default: false },
  antidelete: { type: Boolean, default: false },
  nsfw: { type: Boolean, default: false },
  bangroup: { type: Boolean, default: false },
  chatBot: { type: Boolean, default: false },
  botSwitch: { type: Boolean, default: true },
  switchNSFW: { type: Boolean, default: false },
  switchWelcome: { type: Boolean, default: false },
});

const UserSchema = new mongoose.Schema<IUserData>({
  id: { type: String, unique: true, required: true },
  ban: { type: Boolean, default: false },
  name: { type: String },
  addedMods: { type: Boolean, default: false },
});

const CoreSchema = new mongoose.Schema<ISystemData>({
  id: { type: String, unique: false, required: true, default: "1" },
  seletedCharacter: { type: String, default: "0" },
  PMchatBot: { type: Boolean, default: false },
  botMode: { type: String, default: "public" },
});

const PluginSchema = new mongoose.Schema<IPluginData>({
  plugin: { type: String },
  url: { type: String },
});

const userData: Model<IUserData> = db1.model<IUserData>("UserData", UserSchema);
const groupData: Model<IGroupData> = db1.model<IGroupData>("GroupData", GroupSchema);
const systemData: Model<ISystemData> = db2.model<ISystemData>("SystemData", CoreSchema);
const pluginData: Model<IPluginData> = db2.model<IPluginData>("PluginData", PluginSchema);

export { userData, groupData, systemData, pluginData };
