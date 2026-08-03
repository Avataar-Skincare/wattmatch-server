import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export class CIRegistration extends Model<
  InferAttributes<CIRegistration>,
  InferCreationAttributes<CIRegistration>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare company: string;
  declare email: string;
  declare phone: string;
  declare state: string;
  declare load: string;
  declare siteLocation: string | null;
  declare targetCapacity: string | null;
  declare tenurePreference: string | null;
  declare message: string | null;
  declare consentGiven: boolean;
  declare consentGivenAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

CIRegistration.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    company: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING, allowNull: false },
    state: { type: DataTypes.STRING, allowNull: false },
    load: { type: DataTypes.STRING, allowNull: false },
    siteLocation: { type: DataTypes.STRING, allowNull: true },
    targetCapacity: { type: DataTypes.STRING, allowNull: true },
    tenurePreference: { type: DataTypes.STRING, allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: true },
    consentGiven: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    consentGivenAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_ci_registrations',
    underscored: true,
  }
);
