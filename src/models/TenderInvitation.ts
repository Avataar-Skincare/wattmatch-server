import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type TenderInvitationStatus = 'invited' | 'accepted' | 'declined';

// The gate between "matched" and "can actually see/bid on this tender" — see the discussion in
// MINIMAL_PIPELINE_INTEGRATION_PLAN.md's follow-up on invitation-gated visibility. A generator
// appearing in /tenders/:id/matches has no access to anything until a row exists here; existence
// with status 'invited' or 'accepted' is what GET /tenders/:id and the vetting-bid submission route
// both check.
export class TenderInvitation extends Model<InferAttributes<TenderInvitation>, InferCreationAttributes<TenderInvitation>> {
  declare id: CreationOptional<number>;
  declare tenderId: number;
  declare organizationId: number;
  declare status: CreationOptional<TenderInvitationStatus>;
  declare invitedAt: CreationOptional<Date>;
  declare respondedAt: Date | null;
  // Set by the (not yet built) RfS-fee payment webhook — see PAYMENT_MODULE_PLAN.md. Until that
  // lands there is no route that ever sets this true; the buyer-identity gate on GET /tenders/:id
  // stays permanently closed rather than faked open, which is the correct default, not a stub.
  declare feesPaid: CreationOptional<boolean>;
  declare feesPaidAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
}

TenderInvitation.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    organizationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    status: { type: DataTypes.ENUM('invited', 'accepted', 'declined'), allowNull: false, defaultValue: 'invited' },
    invitedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    respondedAt: { type: DataTypes.DATE, allowNull: true },
    feesPaid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    feesPaidAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tender_invitations',
    underscored: true,
    updatedAt: false,
  }
);
