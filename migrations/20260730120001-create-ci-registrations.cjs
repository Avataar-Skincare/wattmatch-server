'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wattmatch_ci_registrations', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      name: { type: Sequelize.STRING, allowNull: false },
      company: { type: Sequelize.STRING, allowNull: false },
      email: { type: Sequelize.STRING, allowNull: false },
      phone: { type: Sequelize.STRING, allowNull: false },
      state: { type: Sequelize.STRING, allowNull: false },
      load: { type: Sequelize.STRING, allowNull: false },
      site_location: { type: Sequelize.STRING, allowNull: true },
      target_capacity: { type: Sequelize.STRING, allowNull: true },
      tenure_preference: { type: Sequelize.STRING, allowNull: true },
      message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('wattmatch_ci_registrations', ['email']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wattmatch_ci_registrations');
  },
};
