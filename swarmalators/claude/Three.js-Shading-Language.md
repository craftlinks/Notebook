## TSL Specification

An Approach to Productive and Maintainable Shader Creation.

- [Introduction](#introduction)
  - [Why TSL?](#why-tsl)
  - [Example](#example)
  - [Architecture](#architecture)
- [Learning TSL](#learning-tsl)
- [Constants and explicit conversions](#constants-and-explicit-conversions)
- [Conversions](#conversions)
- [Uniform](#uniform)
  - [onUpdate](#uniformonupdate)
- [Swizzle](#swizzle)
- [Operators](#operators)
- [Function](#function)
- [Variables](#variables)
- [Varying](#varying)
- [Conditional](#conditional)
  - [If-else](#if-else)
  - [Switch-case](#switch-case)
  - [Ternary](#ternary)
- [Loop](#loop)
- [Math](#math)
- [Method chaining](#method-chaining)
- [Texture](#texture)
- [Attributes](#attributes)
- [Position](#position)
- [Normal](#normal)
- [Tangent](#tangent)
- [Bitangent](#bitangent)
- [Camera](#bitangent)
- [Model](#bitangent)
- [Screen](#screen)
- [Viewport](#viewport)
- [Blend Modes](#blend-modes)
- [Reflect](#reflect)
- [UV Utils](#uv-utils)
- [Interpolation](#interpolation)
- [Random](#random)
- [Rotate](#rotate)
- [Oscillator](#oscillator)
- [Packing](#packing)
- [NodeMaterial](#nodematerial)
  - [LineDashedNodeMaterial](#linedashednodematerial)
  - [MeshPhongNodeMaterial](#meshphongnodematerial)
  - [MeshStandardNodeMaterial](#meshstandardnodematerial)
    - [MeshPhysicalNodeMaterial](#meshphysicalnodematerial)
  - [SpriteNodeMaterial](#spritenodematerial)
- [Transitioning common GLSL properties to TSL](#transitioning-common-glsl-properties-to-tsl)

## Introduction

### Why TSL?

Creating shaders has always been an advanced step for most developers, many game
developers have never created GLSL code from scratch. The shader graph solution
adopted today by the industry has allowed developers more focused on dynamics to
create the necessary graphic effects to meet the demands of their projects.

The aim of the project is to create an easy-to-use, environment for shader
creation. Even if for this we need to create complexity behind, this happened
initially with `Renderer` and now with the `TSL`.

Other benefits that TSL brings besides simplifying shading creation is keeping
the `renderer agnostic`, while all the complexity of a material can be imported
into different modules and use `tree shaking` without breaking during the
process.

### Example

A `detail map` makes things look more real in games. It adds tiny details like
cracks or bumps to surfaces. In this example we will scale uv to improve details
when seen up close and multiply with a base texture.

#### Old

This is how we would achieve that using `.onBeforeCompile()`:

```js
const material = new THREE.MeshStandardMaterial();
material.map = colorMap;
material.onBeforeCompile = (shader) => {
	shader.uniforms.detailMap = { value: detailMap };

	let token = "#define STANDARD";

	let insert = /* glsl */ `
		uniform sampler2D detailMap;
	`;

	shader.fragmentShader = shader.fragmentShader.replace(
		token,
		token + insert,
	);

	token = "#include <map_fragment>";

	insert = /* glsl */ `
		diffuseColor *= texture2D( detailMap, vMapUv * 10.0 );
	`;

	shader.fragmentShader = shader.fragmentShader.replace(
		token,
		token + insert,
	);
};
```

Any simple change from this makes the code increasingly complicated using
`.onBeforeCompile`, the result we have today in the community are countless
types of parametric materials that do not communicate with each other, and that
need to be updated periodically to be operating, limiting the creativity to
create unique materials reusing modules in a simple way.

#### New

With `TSL` the code would look like this:

```js
import { texture, uv } from "three/tsl";

const detail = texture(detailMap, uv().mul(10));

const material = new THREE.MeshStandardNodeMaterial();
material.colorNode = texture(colorMap).mul(detail);
```

`TSL` is also capable of encoding code into different outputs such as
`WGSL`/`GLSL` - `WebGPU`/`WebGL`, in addition to optimizing the shader graph
automatically and through codes that can be inserted within each `Node`. This
allows the developer to focus on productivity and leave the graphical management
part to the `Node System`.

Another important feature of a graph shader is that we will no longer need to
care about the sequence in which components are created, because the
`Node System` will only declare and include it once.

Let's say that you import `positionWorld` into your code, even if another
component uses it, the calculations performed to obtain `position world` will
only be performed once, as is the case with any other node such as:
`normalWorld`, `modelPosition`, etc.

### Architecture

All `TSL` components are extended from `Node` class. The `Node` allows it to
communicate with any other, value conversions can be automatic or manual, a
`Node` can receive the output value expected by the parent `Node` and modify its
own output snippet. It's possible to modulate them using `tree shaking` in the
shader construction process, the `Node` will have important information such as
`geometry`, `material`, `renderer` as well as the `backend`, which can influence
the type and value of output.

The main class responsible for creating the code is `NodeBuilder`. This class
can be extended to any output programming language, so you can use TSL for a
third language if you wish. Currently `NodeBuilder` has two extended classes,
the `WGSLNodeBuilder` aimed at WebGPU and `GLSLNodeBuilder` aimed at WebGL2.

The build process is based on three pillars: `setup`, `analyze` and `generate`.

|            |                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`    | Use `TSL` to create a completely customized code for the `Node` output. The `Node` can use many others within itself, have countless inputs, but there will always be a single output.             |
| `analyze`  | This proccess will check the `nodes` that were created in order to create useful information for `generate` the snippet, such as the need to create or not a cache/variable for optimizing a node. |
| `generate` | An output of `string` will be returned from each `node`. Any node will also be able to create code in the flow of shader, supporting multiple lines.                                               |

`Node` also have a native update process invoked by the `update()` function,
these events be called by `frame`, `render call` and `object draw`.

It is also possible to serialize or deserialize a `Node` using `serialize()` and
`deserialize()` functions.

## Learning TSL

TSL is a Node-based shader abstraction, written in JavaScript. TSL's functions
are inspired by GLSL, but follow a very different concept. WGSL and GLSL are
focused on creating GPU programs, in TSL this is one of the features.

### Seamless Integration with JavaScript/TypeScript

- Unified Code
  - Write shader logic directly in JS/TS, eliminating the need to manipulate
    strings.
  - Create and manipulate render objects just like any other JavaScript logic
    inside a TSL function.
  - Advanced events to control a Node before and after the object is rendered.
- JS Ecosystem
  - Use native **import/export**, **NPM**, and integrate **JS/TS** components
    directly into your shader logic.
- Typing
  - Benefit from better type checking (especially with **TypeScript** and
    **[@three-types](https://github.com/three-types/three-ts-types)**),
    increasing code robustness.

### Shader-Graph Inspired Structure

- Focus on Intent
  - Build materials by connecting nodes through: [positionWorld](#position),
    [normalWorld](#normal), [screenUV](#screen), [attribute()](#attributes),
    etc. More declarative("what") vs. imperative("how").
- Composition & High-Level Concepts
  - Work with high-level concepts for Node Material like [colorNode](#basic),
    [roughnessNode](#standard), [metalnessNode](#standard),
    [positionNode](#basic), etc. This preserves the integrity of the lighting
    model while allowing customizations, helping to avoid mistakes from
    incorrect setups.
- Keeping an eye on software exchange
  - Modern 3D authoring software uses Shader-Graph based material composition to
    exchange between other software. TSL already has its own MaterialX
    integration.
- Easier Migration
  - Many functions are directly inspired by GLSL to smooth the learning curve
    for those with prior experience.

### Rendering Manipulation

- Control rendering steps and create new render-passes per individual TSL
  functions.
  - Implement complex effects is easily with nodes using a single function call
    either in post-processing and in materials allowing the node itself to
    manage the rendering process as it needs.
    - `gaussianBlur()`: Double render-pass gaussian blur node. It can be used in
      the material or in post-processing through a single function.
  - Easy access to renderer buffers using TSL functions like:
    - `viewportSharedTexture()`: Accesses the beauty what has already been
      rendered, preserving the render-order.
    - `viewportLinearDepth()`: Accesses the depth what has already been
      rendered, preserving the render-order.
  - Integrated Compute Shaders
    - Perform calculations on buffers using compute stage directly during an
      object's rendering.
  - TSL allows dynamic manipulation of renderer functions, which makes it more
    customizable than intermediate languages ​​that would have to use flags in
    fixed pipelines for this.
  - You just need to use the events of a Node for the renderer manipulations,
    without needing to modify the core.

### Automatic Optimization and Workarounds

- Your TSL code automatically benefits from optimizations and workarounds
  implemented in the Three.js compiler with each new version.
  - Simplifications
    - Automatic type conversions.
    - Execute a block of code in vertex-stage and get it in fragment-stage just
      using `vertexStage( node )`.
    - Automatically choose interpolation method for varyings depending on type.
    - Don't worry about collisions of global variables internally when using
      Nodes.
  - Polyfills
    - e.g: `textureSample()` function in the vertex shader (not natively
      supported in WGSL) is correctly transpiled to work.
    - e.g: Automatic correction for the `pow()` function, which didn't accept
      negative bases on Windows/DirectX using WGSL.
  - Optimizations
    - Repeated expressions: TSL can automatically create temporary variables to
      avoid redundant calculations.
    - Automatic reuse of uniforms and attributes.
    - Creating varying only if necessary. Otherwise they are replaced by simple
      variables.

### Target audience

- Beginners users
  - You only need one line to create your first custom shader.
- Advanced users
  - Makes creating shaders simple but not limited. Example:
    https://www.youtube.com/watch?v=C2gDL9Qk_vo
  - If you don't like fixed pipelines and low level, you'll love this.

### Share everything

#### TSL is based on Nodes, so don't worry about sharing your **functions** and **uniforms** across materials and post-processing.

```js
// Shared the same uniform with various materials

const sharedColor = uniform(new THREE.Color());

materialA.colorNode = sharedColor.div(2);
materialB.colorNode = sharedColor.mul(.5);
materialC.colorNode = sharedColor.add(.5);
```

#### Deferred Function: High level of customization, goodby **#defines**

Access **material**, **geometry**, **object**, **camera**, **scene**,
**renderer** and more directly from a TSL function. Function calls are only
performed at the time of building the shader allowing you to customize the
function according to the object's setup.

```js
// Returns a uniform of the material's custom color if it exists

const customColor = Fn(({ material, geometry, object }) => {
	if (material.customColor !== undefined) {
		return uniform(material.customColor);
	}

	return vec3(0);
});

//

material.colorNode = customColor();
```

#### Load a texture-based matrix inside a TSL function

This can be used for any other JS and Three.js ecosystem needs. You can
manipulate your assets according to the needs of a function. This can work for
creating buffers, attributes, uniforms and any other JavaScript operation.

```js
let bayer16Texture = null;

export const bayer16 = Fn(([uv]) => {
	if (bayer16Texture === null) {
		const bayer16Base64 = "data:image/png;base64,...==";

		bayer16Texture = new TextureLoader().load(bayer16Base64);
	}

	return textureLoad(bayer16Texture, ivec2(uv).mod(int(16)));
});

//

material.colorNode = bayer16(screenCoordinate);
```

#### The node architecture allows the creation of instances of custom attributes and buffers through simple functions.

```js
// Range values node example

const randomColor = range(new THREE.Color(0x000000), new THREE.Color(0xFFFFFF));

material.colorNode = randomColor;

//...

const mesh = new THREE.InstancedMesh(geometry, material, count);
```

#### TSL loves JavaScript

TSL syntax follows JavaScript style because they are the same thing, so if you
come from GLSL you can explore new possibilities.

```js
// A simple example of Function closure

const mainTask = Fn(() => {
	const task2 = Fn(([a, b]) => {
		return a.add(b).mul(0.5);
	});

	return task2(color(0x00ff00), color(0x0000ff));
});

//

material.colorNode = mainTask();
```

#### Simplification

Double render-pass `gaussianBlur()` node. It can be used in the material or in
post-processing through a single function.

```js
// Applies a double render-pass gaussianBlur and then a grayscale filter before the object with the material is rendered.

const myTexture = texture(map);

material.colorNode = grayscale(gaussianBlur(myTexture, 4));
```

Accesses what has already been rendered, preserving the render-order for easy
refraction effects, avoiding multiple render-pass and manual sorts.

```js
// Leaving the back in grayscale.

material.colorNode = grayscale(viewportSharedTexture(screenUV));
material.transparent = true;
```

#### Extend the TSL

You no longer need to create a Material for each desired effect, instead create
Nodes. A Node can have access to the Material and can be used in many ways.
Extend the TSL from Nodes and let the user use it in creative ways.

A great example of this is
[TSL-Textures](https://boytchev.github.io/tsl-textures/).

```js
import * as THREE from "three";
import { simplexNoise } from "tsl-textures";

material.colorNode = simplexNoise({
	scale: 2,
	balance: 0,
	contrast: 0,
	color: new THREE.Color(16777215),
	background: new THREE.Color(0),
	seed: 0,
});
```

## Constants and explicit conversions

Input functions can be used to create contants and do explicit conversions.

> Conversions are also performed automatically if the output and input are of
> different types.

| Name                                                     | Returns a constant or convertion of type: |
| -------------------------------------------------------- | ----------------------------------------- |
| `float( node\|number )`                                  | `float`                                   |
| `int( node\|number )`                                    | `int`                                     |
| `uint( node\|number )`                                   | `uint`                                    |
| `bool( node\|value )`                                    | `boolean`                                 |
| `color( node\|hex\|r,g,b )`                              | `color`                                   |
| `vec2( node\|Vector2\|x,y )`                             | `vec2`                                    |
| `vec3( node\|Vector3\|x,y,z )`                           | `vec3`                                    |
| `vec4( node\|Vector4\|x,y,z,w )`                         | `vec4`                                    |
| `mat2( node\|Matrix2\|a,b,c,d )`                         | `mat2`                                    |
| `mat3( node\|Matrix3\|a,b,c,d,e,f,g,h,i )`               | `mat3`                                    |
| `mat4( node\|Matrix4\|a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p )` | `mat4`                                    |
| `ivec2( node\|x,y )`                                     | `ivec2`                                   |
| `ivec3( node\|x,y,z )`                                   | `ivec3`                                   |
| `ivec4( node\|x,y,z,w )`                                 | `ivec4`                                   |
| `uvec2( node\|x,y )`                                     | `uvec2`                                   |
| `uvec3( node\|x,y,z )`                                   | `uvec3`                                   |
| `uvec4( node\|x,y,z,w )`                                 | `uvec4`                                   |
| `bvec2( node\|x,y )`                                     | `bvec2`                                   |
| `bvec3( node\|x,y,z )`                                   | `bvec3`                                   |
| `bvec4( node\|x,y,z,w )`                                 | `bvec4`                                   |

Example:

```js
import { color, positionWorld, vec2 } from "three/tsl";

// constant
material.colorNode = color(0x0066ff);

// conversion
material.colorNode = vec2(positionWorld); // result positionWorld.xy
```

## Conversions

It is also possible to perform conversions using the `method chaining`:

| Name         | Returns a constant or conversion of type: |
| ------------ | ----------------------------------------- |
| `.toFloat()` | `float`                                   |
| `.toInt()`   | `int`                                     |
| `.toUint()`  | `uint`                                    |
| `.toBool()`  | `boolean`                                 |
| `.toColor()` | `color`                                   |
| `.toVec2()`  | `vec2`                                    |
| `.toVec3()`  | `vec3`                                    |
| `.toVec4()`  | `vec4`                                    |
| `.toMat2()`  | `mat2`                                    |
| `.toMat3()`  | `mat3`                                    |
| `.toMat4()`  | `mat4`                                    |
|              |                                           |
| `.toIVec2()` | `ivec2`                                   |
| `.toIVec3()` | `ivec3`                                   |
| `.toIVec4()` | `ivec4`                                   |
| `.toUVec2()` | `uvec2`                                   |
| `.toUVec3()` | `uvec3`                                   |
| `.toUVec4()` | `uvec4`                                   |
| `.toBVec2()` | `bvec2`                                   |
| `.toBVec3()` | `bvec3`                                   |
| `.toBVec4()` | `bvec4`                                   |

Example:

```js
import { positionWorld } from "three/tsl";

// conversion
material.colorNode = positionWorld.toVec2(); // result positionWorld.xy
```

## Uniform

Uniforms are useful to update values of variables like colors, lighting, or
transformations without having to recreate the shader program. They are the true
variables from a GPU's point of view.

| Name                                                                                                        | Description     |
| ----------------------------------------------------------------------------------------------------------- | --------------- |
| `uniform( boolean \| number \| Color \| Vector2 \| Vector3 \| Vector4 \| Matrix3 \| Matrix4, type = null )` | Dynamic values. |

Example:

```js
const myColor = uniform(new THREE.Color(0x0066FF));

material.colorNode = myColor;
```

### `uniform.on*Update()`

It is also possible to create update events on `uniforms`, which can be defined
by the user:

| Name                          | Description                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.onObjectUpdate( function )` | It will be updated every time an object like `Mesh` is rendered with this `node` in `Material`.                                                                                         |
| `.onRenderUpdate( function )` | It will be updated once per render, common and shared materials, fog, tone mapping, etc.                                                                                                |
| `.onFrameUpdate( function )`  | It will be updated only once per frame, recommended for values ​​that will be updated only once per frame, regardless of when `render-pass` the frame has, cases like `time` for example. |

Example:

```js
const posY = uniform(0); // it's possible use uniform( 'float' )

// or using event to be done automatically
// { object } will be the current rendering object
posY.onObjectUpdate(({ object }) => object.position.y);

// you can also update manually using the .value property
posY.value = object.position.y;

material.colorNode = posY;
```

## Swizzle

Swizzling is the technique that allows you to access, reorder, or duplicate the
components of a vector using a specific notation within TSL. This is done by
combining the identifiers:

```js
const original = vec3(1.0, 2.0, 3.0); // (x, y, z)
const swizzled = original.zyx; // swizzled = (3.0, 2.0, 1.0)
```

It's possible use `xyzw`, `rgba` or `stpq`.

## Operators

| Name                                 | Description                                                      |
| ------------------------------------ | ---------------------------------------------------------------- |
| `.add( node \| value, ... )`         | Return the addition of two or more value.                        |
| `.sub( node \| value )`              | Return the subraction of two or more value.                      |
| `.mul( node \| value )`              | Return the multiplication of two or more value.                  |
| `.div( node \| value )`              | Return the division of two or more value.                        |
| `.assign( node \| value )`           | Assign one or more value to a and return the same.               |
| `.mod( node \| value )`              | Computes the remainder of dividing the first node by the second. |
| `.equal( node \| value )`            | Checks if two nodes are equal.                                   |
| `.notEqual( node \| value )`         | Checks if two nodes are not equal.                               |
| `.lessThan( node \| value )`         | Checks if the first node is less than the second.                |
| `.greaterThan( node \| value )`      | Checks if the first node is greater than the second.             |
| `.lessThanEqual( node \| value )`    | Checks if the first node is less than or equal to the second.    |
| `.greaterThanEqual( node \| value )` | Checks if the first node is greater than or equal to the second. |
| `.and( node \| value )`              | Performs logical AND on two nodes.                               |
| `.or( node \| value )`               | Performs logical OR on two nodes.                                |
| `.not( node \| value )`              | Performs logical NOT on a node.                                  |
| `.xor( node \| value )`              | Performs logical XOR on two nodes.                               |
| `.bitAnd( node \| value )`           | Performs bitwise AND on two nodes.                               |
| `.bitNot( node \| value )`           | Performs bitwise NOT on a node.                                  |
| `.bitOr( node \| value )`            | Performs bitwise OR on two nodes.                                |
| `.bitXor( node \| value )`           | Performs bitwise XOR on two nodes.                               |
| `.shiftLeft( node \| value )`        | Shifts a node to the left.                                       |
| `.shiftRight( node \| value )`       | Shifts a node to the right.                                      |

```js
const a = float(1);
const b = float(2);

const result = a.add(b); // output: 3
```

## Function

### `Fn( function )`

It is possible to use classic JS functions or a `Fn()` interface. The main
difference is that `Fn()` creates a controllable environment, allowing the use
of `stack` where you can use `assign` and `conditional`, while the classic
function only allows inline approaches.

Example:

```js
// tsl function
const oscSine = Fn(([t = time]) => {
	return t.add(0.75).mul(Math.PI * 2).sin().mul(0.5).add(0.5);
});

// inline function
export const oscSine = (t = time) =>
	t.add(0.75).mul(Math.PI * 2).sin().mul(0.5).add(0.5);
```

> Both above can be called with `oscSin( value )`.

TSL allows the entry of parameters as objects, this is useful in functions that
have many optional arguments.

Example:

```js
const oscSine = Fn(({ timer = time }) => {
	return timer.add(0.75).mul(Math.PI * 2).sin().mul(0.5).add(0.5);
});

const value = oscSine({ timer: value });
```

If you want to use an export function compatible with `tree shaking`, remember
to use `/*@__PURE__*/`

```js
export const oscSawtooth = /*@__PURE__*/ Fn(([timer = time]) => timer.fract());
```

The second parameter of the function, if there are any parameters, will always
be the first if there are none, and is dedicated to `NodeBuilder`. In
`NodeBuilder` you can find out details about the current construction process
and also obtain objects related to the shader construction, such as `material`,
`geometry`, `object`, `camera`, etc.

[See an example](#deferred-function-high-level-of-customization-goodby-defines)

## Variables

Functions used to declare variables.

| Name                                                            | Description                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `.toVar( node, name = null )` or `Var( node, name = null )`     | Converts a node into a reusable variable in the shader.    |
| `.toConst( node, name = null )` or `Const( node, name = null )` | Converts a node into an inline constant.                   |
| `property( type, name = null )`                                 | Declares an property but does not assign an initial value. |

The name is optional; if set to `null`, the node system will generate one
automatically.\
Creating a variable, constant, or property can help optimize the shader graph
manually or assist in debugging.

```js
const uvScaled = uv().mul(10).toVar();

material.colorNode = texture(map, uvScaled);
```

---

## Varying

Functions used to declare varying.

| Name                                   | Description                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `vertexStage( node )`                  | Computes the node in the vertex stage.                                                       |
| `varying( node, name = null )`         | Computes the node in the vertex stage and passes interpolated values to the fragment shader. |
| `varyingProperty( type, name = null )` | Declares an varying property but does not assign an initial value.                           |

Let's suppose you want to optimize some calculation in the `vertex stage` but
are using it in a slot like `material.colorNode`.

For example:

```js
// multiplication will be executed in vertex stage
const normalView = vertexStage(modelNormalMatrix.mul(normalLocal));

// normalize will be computed in fragment stage while `normalView` is computed on vertex stage
material.colorNode = normalView.normalize();
```

The first parameter of `vertexStage()` `modelNormalMatrix.mul( normalLocal )`
will be computed in `vertex stage`, and the return from `vertexStage()` will be
a `varying` as we are used in WGSL/GLSL, this can optimize extra calculations in
the `fragment stage`. The second parameter of `varying()` allows you to add a
custom name in code generation.

If `varying()` is added only to `material.positionNode`, it will only return a
simple variable and varying will not be created because `material.positionNode`
is one of the only nodes that are computed at the vertex stage.

## Conditional

### If-else

`If-else` conditionals can be used within `Fn()`. Conditionals in `TSL` are
built using the `If` function:

```js
If( conditional, function )
.ElseIf( conditional, function )
.Else( function )
```

> Notice here the `i` in `If` is capitalized.

Example:

In this example below, we will limit the y position of the geometry to 10.

```js
const limitPosition = Fn(({ position }) => {
	const limit = 10;

	// Convert to variable using `.toVar()` to be able to use assignments.
	const result = position.toVec3().toVar();

	If(result.y.greaterThan(limit), () => {
		result.y = limit;
	});

	return result;
});

material.positionNode = limitPosition({ position: positionLocal });
```

Example using `elseif`:

```js
const limitPosition = Fn(({ position }) => {
	const limit = 10;

	// Convert to variable using `.toVar()` to be able to use assignments.
	const result = position.toVec3().toVar();

	If(result.y.greaterThan(limit), () => {
		result.y = limit;
	}).ElseIf(result.y.lessThan(limit), () => {
		result.y = limit;
	});

	return result;
});

material.positionNode = limitPosition({ position: positionLocal });
```

### Switch-Case

A Switch-Case statement is an alternative way to express conditional logic
compared to If-Else.

```js
const col = color().toVar();

Switch(0)
	.Case(0, () => {
		col.assign(color(1, 0, 0));
	}).Case(1, () => {
		col.assign(color(0, 1, 0));
	}).Case(2, 3, () => {
		col.assign(color(0, 0, 1));
	}).Default(() => {
		col.assign(color(1, 1, 1));
	});
```

Notice that there are some rules when using this syntax which differentiate TSL
from JavaScript:

- There is no fallthrough support. So each `Case()` statement has an implicit
  break.
- A `Case()` statement can hold multiple values (selectors) for testing.

### Ternary

Different from `if-else`, a ternary conditional will return a value and can be
used outside of `Fn()`.

```js
const result = select(value.greaterThan(1), 1.0, value);
```

> Equivalent in JavaScript should be: `value > 1 ? 1.0 : value`

## Loop

This module offers a variety of ways to implement loops in TSL. In it's basic
form it's:

```js
Loop(count, ({ i }) => {
});
```

However, it is also possible to define a start and end ranges, data types and
loop conditions:

```js
Loop({ start: int(0), end: int(10), type: "int", condition: "<" }, ({ i }) => {
});
```

Nested loops can be defined in a compacted form:

```js
Loop(10, 5, ({ i, j }) => {
});
```

Loops that should run backwards can be defined like so:

```js
Loop({ start: 10 }, () => {});
```

It is possible to execute with boolean values, similar to the `while` syntax.

```js
const value = float(0).toVar();

Loop(value.lessThan(10), () => {
	value.addAssign(1);
});
```

The module also provides `Break()` and `Continue()` TSL expression for loop
control.

## Math

| Name                                | Description                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `EPSION`                            | A small value used to handle floating-point precision errors.                  |
| `INFINITY`                          | Represent infinity.                                                            |
|                                     |                                                                                |
| `abs( x )`                          | Return the absolute value of the parameter.                                    |
| `acos( x )`                         | Return the arccosine of the parameter.                                         |
| `all( x )`                          | Return true if all components of x are true.                                   |
| `any( x )`                          | Return true if any component of x is true.                                     |
| `asin( x )`                         | Return the arcsine of the parameter.                                           |
| `atan( y, x )`                      | Return the arc-tangent of the parameters.                                      |
| `bitcast( x, y )`                   | Reinterpret the bits of a value as a different type.                           |
| `cbrt( x )`                         | Return the cube root of the parameter.                                         |
| `ceil( x )`                         | Find the nearest integer that is greater than or equal to the parameter.       |
| `clamp( x, min, max )`              | Constrain a value to lie between two further values.                           |
| `cos( x )`                          | Return the cosine of the parameter.                                            |
| `cross( x, y )`                     | Calculate the cross product of two vectors.                                    |
| `dFdx( p )`                         | Return the partial derivative of an argument with respect to x.                |
| `dFdy( p )`                         | Return the partial derivative of an argument with respect to y.                |
| `degrees( radians )`                | Convert a quantity in radians to degrees.                                      |
| `difference( x, y )`                | Calculate the absolute difference between two values.                          |
| `distance( x, y )`                  | Calculate the distance between two points.                                     |
| `dot( x, y )`                       | Calculate the dot product of two vectors.                                      |
| `equals( x, y )`                    | Return true if x equals y.                                                     |
| `exp( x )`                          | Return the natural exponentiation of the parameter.                            |
| `exp2( x )`                         | Return 2 raised to the power of the parameter.                                 |
| `faceforward( N, I, Nref )`         | Return a vector pointing in the same direction as another.                     |
| `floor( x )`                        | Find the nearest integer less than or equal to the parameter.                  |
| `fract( x )`                        | Compute the fractional part of the argument.                                   |
| `fwidth( x )`                       | Return the sum of the absolute derivatives in x and y.                         |
| `inverseSqrt( x )`                  | Return the inverse of the square root of the parameter.                        |
| `length( x )`                       | Calculate the length of a vector.                                              |
| `lengthSq( x )`                     | Calculate the squared length of a vector.                                      |
| `log( x )`                          | Return the natural logarithm of the parameter.                                 |
| `log2( x )`                         | Return the base 2 logarithm of the parameter.                                  |
| `max( x, y )`                       | Return the greater of two values.                                              |
| `min( x, y )`                       | Return the lesser of two values.                                               |
| `mix( x, y, a )`                    | Linearly interpolate between two values.                                       |
| `negate( x )`                       | Negate the value of the parameter ( -x ).                                      |
| `normalize( x )`                    | Calculate the unit vector in the same direction as the original vector.        |
| `oneMinus( x )`                     | Return 1 minus the parameter.                                                  |
| `pow( x, y )`                       | Return the value of the first parameter raised to the power of the second.     |
| `pow2( x )`                         | Return the square of the parameter.                                            |
| `pow3( x )`                         | Return the cube of the parameter.                                              |
| `pow4( x )`                         | Return the fourth power of the parameter.                                      |
| `radians( degrees )`                | Convert a quantity in degrees to radians.                                      |
| `reciprocal( x )`                   | Return the reciprocal of the parameter (1/x).                                  |
| `reflect( I, N )`                   | Calculate the reflection direction for an incident vector.                     |
| `refract( I, N, eta )`              | Calculate the refraction direction for an incident vector.                     |
| `round( x )`                        | Round the parameter to the nearest integer.                                    |
| `saturate( x )`                     | Constrain a value between 0 and 1.                                             |
| `sign( x )`                         | Extract the sign of the parameter.                                             |
| `sin( x )`                          | Return the sine of the parameter.                                              |
| `smoothstep( e0, e1, x )`           | Perform Hermite interpolation between two values.                              |
| `sqrt( x )`                         | Return the square root of the parameter.                                       |
| `step( edge, x )`                   | Generate a step function by comparing two values.                              |
| `tan( x )`                          | Return the tangent of the parameter.                                           |
| `transformDirection( dir, matrix )` | Transform the direction of a vector by a matrix and then normalize the result. |
| `trunc( x )`                        | Truncate the parameter, removing the fractional part.                          |
