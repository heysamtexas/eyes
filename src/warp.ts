/**
 * Final display pass: shows the composited portrait and nudges each face toward where it is
 * looking. Each face is pushed by a smooth Gaussian bump centred on its middle, so the nose
 * and eyes move most, cheeks less and the outline barely: a cheap stand-in for a head turn,
 * with no seams to hide.
 */

export const MAX_WARP_FACES = 12;

export interface WarpFace {
  /** Centre and Gaussian radii, in pixels. */
  x: number;
  y: number;
  sx: number;
  sy: number;
  /** Displacement at the centre, in pixels. */
  dx: number;
  dy: number;
}

const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D image;
uniform int count;
uniform vec4 shape[${MAX_WARP_FACES}];
uniform vec2 shift[${MAX_WARP_FACES}];
in vec2 uv;
out vec4 color;
void main() {
  vec2 d = vec2(0.0);
  for (int i = 0; i < ${MAX_WARP_FACES}; i++) {
    if (i >= count) break;
    vec2 q = (uv - shape[i].xy) / shape[i].zw;
    d += shift[i] * exp(-0.5 * dot(q, q));
  }
  color = texture(image, uv - d);
}`;

export class FaceWarp {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;

  /** Returns null when WebGL2 isn't available; the caller then draws without the warp. */
  static create(canvas: HTMLCanvasElement): FaceWarp | null {
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, alpha: false });
    if (!gl) return null;
    try {
      return new FaceWarp(gl);
    } catch (err) {
      console.warn("Head-turn warp unavailable", err);
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, "pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  render(source: HTMLCanvasElement, faces: WarpFace[]): void {
    const { gl } = this;
    const W = source.width;
    const H = source.height;
    if (gl.canvas.width !== W || gl.canvas.height !== H) {
      gl.canvas.width = W;
      gl.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    const used = faces.slice(0, MAX_WARP_FACES);
    const shape = new Float32Array(MAX_WARP_FACES * 4);
    const shift = new Float32Array(MAX_WARP_FACES * 2);
    used.forEach((f, i) => {
      shape.set([f.x / W, f.y / H, f.sx / W, f.sy / H], i * 4);
      shift.set([f.dx / W, f.dy / H], i * 2);
    });
    gl.uniform1i(gl.getUniformLocation(this.program, "count"), used.length);
    gl.uniform4fv(gl.getUniformLocation(this.program, "shape"), shape);
    gl.uniform2fv(gl.getUniformLocation(this.program, "shift"), shift);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
