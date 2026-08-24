import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type TenderRequestStatus = 'pending' | 'converted' | 'declined';

// Stage 1/2 changed shape: a buyer no longer posts a live Tender directly (see routes/tenders.ts's
// admin-only POST /tenders) — they submit a request describing what they want, and an internal
// admin turns it into a real, priced Tender. This is the request half; `tenderId` is set once an
// admin converts it, so a buyer can always find the resulting tender from their own request list.
export class TenderRequest extends Model<InferAttributes<TenderRequest>, InferCreationAttributes<TenderRequest>> {
  declare id: CreationOptional<number>;
  declare buyerOrgId: number;
  declare title: string;
  declare requiredCapacityMw: string;
  declare requirementsDetail: string | null;
  declare status: CreationOptional<TenderRequestStatus>;
  declare tenderId: number | null;
  declare readonly createdAt: CreationOptional<Date>;
}

TenderRequest.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    buyerOrgId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    requiredCapacityMw: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    requirementsDetail: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('pending', 'converted', 'declined'), allowNull: false, defaultValue: 'pending' },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tender_requests',
    underscored: true,
    updatedAt: false,
  }
);
