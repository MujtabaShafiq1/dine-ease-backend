import { HydratedDocument, Types } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export interface PlanDocument extends HydratedDocument<Plan> {
  id: Types.ObjectId;
  charges: number;
  durationInMonths: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Schema({
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      return ret;
    },
  },
  timestamps: true,
})
export class Plan {
  @Prop({ required: true })
  charges: number;

  @Prop({ required: true })
  durationInMonths: number;

  @Prop({ default: true })
  isActive: boolean;
}

export const PlanSchema = SchemaFactory.createForClass(Plan);
