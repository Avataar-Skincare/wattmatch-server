'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_tender_requests', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      buyer_org_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      title: { type: Sequelize.STRING, allowNull: false },
      required_capacity_mw: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      requirements_detail: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM('pending', 'converted', 'declined'), allowNull: false, defaultValue: 'pending' },
      tender_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('wattmatch_tender_requests', ['buyer_org_id']);
    await queryInterface.addIndex('wattmatch_tender_requests', ['status']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_tender_requests');
  },
};
