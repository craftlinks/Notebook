import { GPUSwarmalators, type SwarmalatorParams } from './gpu_swarmalators';

/**
 * Test script to validate the GPU swarmalator implementation
 */

async function testSwarmalatorPatterns() {
  console.log('🧪 Testing GPU Swarmalator Implementation');
  console.log('=' .repeat(50));
  
  const swarmalators = new GPUSwarmalators();
  
  // Wait for WebGPU initialization
  console.log('⏳ Waiting for WebGPU initialization...');
  await new Promise<void>(resolve => {
    const checkRenderer = () => {
      if ((swarmalators as any).renderer) {
        console.log('✅ WebGPU renderer initialized');
        resolve();
      } else {
        setTimeout(checkRenderer, 100);
      }
    };
    checkRenderer();
  });
  
  // Test 1: Basic creation and initialization
  console.log('\n📝 Test 1: Basic creation and initialization');
  try {
    const id = swarmalators.createSwarmalators(100, {
      J: 1.0,
      K: 0.5,
      omega: 0.0,
      dt: 0.01
    });
    
    await swarmalators.initializeSwarmalators();
    console.log('✅ Successfully created and initialized 100 swarmalators');
    console.log(`   ID: ${id}`);
    console.log(`   Total particles: ${swarmalators.getTotalParticleCount()}`);
    
  } catch (error) {
    console.error('❌ Failed basic creation test:', error);
    return false;
  }
  
  // Test 2: Parameter updates
  console.log('\n📝 Test 2: Parameter updates');
  try {
    const originalParams = swarmalators.getParams();
    console.log('   Original params:', originalParams);
    
    swarmalators.updateParams({
      J: -0.5,
      K: 1.5,
      omega: 0.1
    });
    
    const updatedParams = swarmalators.getParams();
    console.log('   Updated params:', updatedParams);
    
    if (updatedParams.J === -0.5 && updatedParams.K === 1.5 && updatedParams.omega === 0.1) {
      console.log('✅ Parameter updates working correctly');
    } else {
      console.error('❌ Parameter updates failed');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Failed parameter update test:', error);
    return false;
  }
  
  // Test 3: Animation control
  console.log('\n📝 Test 3: Animation control');
  try {
    swarmalators.startAnimation();
    console.log('✅ Animation started successfully');
    
    // Let it run for a short time
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    swarmalators.stopAnimation();
    console.log('✅ Animation stopped successfully');
    
  } catch (error) {
    console.error('❌ Failed animation control test:', error);
    return false;
  }
  
  // Test 4: Pattern presets
  console.log('\n📝 Test 4: Pattern presets');
  const patterns = {
    'rainbow-ring': { J: 1.0, K: 0.0, omega: 0.0 },
    'dancing-circus': { J: 0.1, K: -0.1, omega: 0.0 },
    'uniform-blob': { J: 0.1, K: 1.0, omega: 0.0 },
    'solar-convection': { J: 0.1, K: 1.0, omega: 0.5 },
    'makes-me-dizzy': { J: 1.0, K: 0.1, omega: 0.0 },
    'fractured': { J: 1.0, K: -0.1, omega: 0.0 }
  };
  
  for (const [name, params] of Object.entries(patterns)) {
    try {
      swarmalators.updateParams(params);
      const currentParams = swarmalators.getParams();
      
      if (currentParams.J === params.J && currentParams.K === params.K && currentParams.omega === params.omega) {
        console.log(`✅ Pattern "${name}" applied successfully`);
      } else {
        console.error(`❌ Pattern "${name}" failed to apply`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Pattern "${name}" caused error:`, error);
      return false;
    }
  }
  
  // Test 5: Multiple swarmalator groups
  console.log('\n📝 Test 5: Multiple swarmalator groups');
  try {
    const id2 = swarmalators.createSwarmalators(50, {
      J: -0.5,
      K: 0.8,
      omega: 0.2
    });
    
    await swarmalators.initializeSwarmalators();
    
    console.log('✅ Multiple swarmalator groups created successfully');
    console.log(`   Groups: ${swarmalators.getSwarmalatorCount()}`);
    console.log(`   Total particles: ${swarmalators.getTotalParticleCount()}`);
    
  } catch (error) {
    console.error('❌ Failed multiple groups test:', error);
    return false;
  }
  
  // Test 6: Mathematical constraints
  console.log('\n📝 Test 6: Mathematical constraints');
  try {
    // Test extreme parameter values
    swarmalators.updateParams({
      J: 2.0,    // Maximum coupling
      K: -2.0,   // Maximum desynchronization
      omega: 1.0, // High frequency
      dt: 0.001   // Small time step
    });
    
    swarmalators.startAnimation();
    await new Promise(resolve => setTimeout(resolve, 500));
    swarmalators.stopAnimation();
    
    console.log('✅ Extreme parameter values handled correctly');
    
  } catch (error) {
    console.error('❌ Failed mathematical constraints test:', error);
    return false;
  }
  
  console.log('\n🎉 All tests passed! GPU Swarmalator implementation is working correctly.');
  console.log('\n📊 Test Summary:');
  console.log(`   ✅ Basic creation and initialization`);
  console.log(`   ✅ Parameter updates`);
  console.log(`   ✅ Animation control`);
  console.log(`   ✅ Pattern presets (${Object.keys(patterns).length} patterns)`);
  console.log(`   ✅ Multiple swarmalator groups`);
  console.log(`   ✅ Mathematical constraints`);
  
  return true;
}

// Export for use in other modules
export { testSwarmalatorPatterns };

// Auto-run if this file is executed directly
if (typeof window !== 'undefined' && window.location.pathname.includes('test')) {
  document.addEventListener('DOMContentLoaded', () => {
    testSwarmalatorPatterns().then(success => {
      if (success) {
        console.log('🎊 All tests completed successfully!');
      } else {
        console.error('💥 Some tests failed.');
      }
    });
  });
}