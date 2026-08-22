'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_tenders', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      buyer_org_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      title: { type: Sequelize.STRING, allowNull: false },
      required_capacity_mw: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      status: { type: Sequelize.ENUM('open', 'vetting', 'live', 'closed'), allowNull: false, defaultValue: 'open' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_tenders', ['buyer_org_id']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_tenders');
  },
};
