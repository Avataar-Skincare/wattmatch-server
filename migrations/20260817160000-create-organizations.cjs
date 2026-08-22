'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_organizations', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      type: { type: Sequelize.ENUM('buyer', 'generator'), allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      contact_email: { type: Sequelize.STRING, allowNull: false },
      contact_phone: { type: Sequelize.STRING, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_organizations');
  },
};
