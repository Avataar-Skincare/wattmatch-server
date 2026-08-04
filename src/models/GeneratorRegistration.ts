import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export class GeneratorRegistration extends Model<
  InferAttributes<GeneratorRegistration>,
  InferCreationAttributes<GeneratorRegistration>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare company: string;
  declare email: string;
  declare phone: string;
  declare phoneCountryCode: string;
  declare state: string;
  declare capacity: string;
  declare siteLocation: string | null;
  declare commissioningTimeline: string | null;
  declare certifications: string | null;
  declare message: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

GeneratorRegistration.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    company: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING, allowNull: false },
    phoneCountryCode: { type: DataTypes.STRING, allowNull: false, defaultValue: '+91' },
    state: { type: DataTypes.STRING, allowNull: false },
    capacity: { type: DataTypes.STRING, allowNull: false },
    siteLocation: { type: DataTypes.STRING, allowNull: true },
    commissioningTimeline: { type: DataTypes.STRING, allowNull: true },
    certifications: { type: DataTypes.TEXT, allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_generator_registrations',
    underscored: true,
  }
);
