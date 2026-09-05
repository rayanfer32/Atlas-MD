import { model, Schema, type Document } from "mongoose";

export interface ISessionDoc extends Document {
  sessionId: string;
  files?: Record<string, string>;
  session?: string;
  lastSync?: Date | null;
}

const schema = new Schema<ISessionDoc>({
  sessionId: {
    type: String,
    required: true,
    unique: true,
  },
  files: {
    type: Schema.Types.Mixed,
    default: {},
  },
  lastSync: {
    type: Date,
    default: null,
  },
});

export default model<ISessionDoc>("sessionschemas", schema);
