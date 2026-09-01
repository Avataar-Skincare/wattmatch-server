'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('wattmatch_payments', 'status', {
      type: Sequelize.ENUM('created', 'attempted', 'paid', 'failed', 'refunded', 'partially_refunded'),
      allowNull: false,
      defaultValue: 'created',
    });
    await queryInterface.addColumn('wattmatch_payments', 'amount_refunded_paise', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('wattmatch_payments', 'amount_refunded_paise');
    await queryInterface.changeColumn('wattmatch_payments', 'status', {
      type: Sequelize.ENUM('created', 'attempted', 'paid', 'failed', 'refunded'),
      allowNull: false,
      defaultValue: 'created',
    });
  },
};
