const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  try {
    const hashedPassword = await bcrypt.hash('12adminx21', 10);
    
    const admin = await prisma.user.create({
      data: {
        email: 'adminx@omo.com',
        password: hashedPassword,
        name: 'Admin User',
        role: 'admin'
      }
    });

    console.log('Admin user created successfully:', admin);
  } catch (error) {
    console.error('Error creating admin user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 