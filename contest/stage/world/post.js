// The picture after the render: bloom only on what is really bright (screens, lamps), depth of
// field on close shots only, then one grade pass: filmic tone curve, a warm-black lift and cool
// shadows, gentle vignette, low film grain, sRGB out. Lite: 2× MSAA, half-size bloom, no depth of field.
import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

export function createPost(renderer, { W, H, lite }) {
  const depthTexture = lite ? null : new THREE.DepthTexture(W, H);
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: lite ? 2 : 4, depthTexture });
  const bloom = new UnrealBloomPass(new THREE.Vector2(lite ? W / 2 : W, lite ? H / 2 : H), 0.3, 0.35, 1.2); // a tight radius: a lamp keeps a small halo, never a disc
  const dofRT = lite ? null : new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType });

  // depth of field: a disc gather with the circle of confusion from depth (close shots only)
  const dof = lite ? null : new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tColor: { value: rt.texture }, tDepth: { value: depthTexture }, uNear: { value: 0.1 }, uFar: { value: 100 },
      uFocus: { value: 3 }, uAperture: { value: 0 }, uTexel: { value: new THREE.Vector2(1 / W, 1 / H) }, uMaxR: { value: 14 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tColor, tDepth; uniform float uNear, uFar, uFocus, uAperture, uMaxR; uniform vec2 uTexel; varying vec2 vUv;
      float lin(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
      // beyond the glass (the pit, >~25 m) the blur is capped: the mine behind a speaker stays readable
      float coc(float z){ float c = clamp(uAperture * abs(z - uFocus) / max(z, 0.1), 0.0, 1.0); return mix(c, min(c, 0.2), smoothstep(14.0, 30.0, z)) * uMaxR; }
      void main(){
        vec4 base = texture2D(tColor, vUv);
        if (uAperture <= 0.0) { gl_FragColor = base; return; }
        float z = lin(texture2D(tDepth, vUv).r);
        float r = coc(z);
        vec3 acc = base.rgb; float w = 1.0;
        const int N = 28;
        for (int i = 0; i < N; i++) {
          float a = float(i) * 2.39996; float k = sqrt((float(i) + 0.5) / float(N));
          vec2 o = vec2(cos(a), sin(a)) * k * uMaxR * uTexel;
          vec2 uv = vUv + o;
          float zs = lin(texture2D(tDepth, uv).r);
          float rs = coc(zs);
          // a sample counts if its own blur reaches here (no sharp halos around in-focus edges)
          float reach = smoothstep(k * uMaxR - 1.5, k * uMaxR, max(min(rs, r * 1.2), zs < z ? rs : 0.0));
          vec3 c = texture2D(tColor, uv).rgb;
          acc += c * reach; w += reach;
        }
        gl_FragColor = vec4(acc / w, 1.0);
      }`,
  }));

  const grade = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tColor: { value: rt.texture }, uExposure: { value: new THREE.Vector3(1, 1, 1) }, uTime: { value: 0 }, uGrain: { value: lite ? 0.0 : 0.018 }, uRes: { value: new THREE.Vector2(W, H) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tColor; uniform vec3 uExposure; uniform float uTime, uGrain; uniform vec2 uRes; varying vec2 vUv;
      // AgX-like filmic curve (fitted), gentle on highlights so screens stay readable
      vec3 agx(vec3 c){
        const mat3 inM = mat3(0.842479, 0.0423282, 0.0423756, 0.0784336, 0.878468, 0.0784336, 0.0792237, 0.0791661, 0.879142);
        const mat3 outM = mat3(1.19688, -0.0528968, -0.0529716, -0.0980209, 1.15190, -0.0980435, -0.0990297, -0.0989612, 1.15107);
        c = inM * c;
        c = clamp(log2(max(c, 1e-10)), -12.47393, 4.026069);
        c = (c + 12.47393) / 16.5;
        vec3 x2 = c * c, x4 = x2 * x2;
        c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
        c = outM * c;
        return pow(max(c, 0.0), vec3(2.2));
      }
      float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
      void main(){
        vec3 c = texture2D(tColor, vUv).rgb * uExposure;
        c = agx(c);
        // grade: warm the blacks a touch, cool the deep shadows, keep mids neutral
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, c * vec3(0.94, 1.0, 1.08), (1.0 - smoothstep(0.0, 0.12, l)) * 0.6);
        c += vec3(0.010, 0.0075, 0.006) * (1.0 - smoothstep(0.0, 0.08, l));
        c = mix(vec3(l), c, 0.96);
        // vignette
        vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
        c *= 1.0 - 0.28 * smoothstep(0.35, 1.05, length(q));
        // sRGB
        c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        // grain, luminance-weighted (more in the mids), animated with the show clock
        float g = hash(vUv * uRes + fract(uTime * 7.31) * 113.0) - 0.5;
        c += g * uGrain * (0.4 + 0.6 * smoothstep(0.05, 0.4, l));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  grade.material.toneMapped = false;

  return {
    rt,
    bloom,
    /** Close shots set this: focus distance (m), aperture (0 = off), exposure (a number or RGB gains). */
    lens: { focus: 3, aperture: 0, exposure: 1 },
    render(scenes, camera, t) {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = false;
      renderer.clear();
      for (const [i, sc] of scenes.entries()) {
        if (i) renderer.clearDepth();
        renderer.render(sc, camera);
      }
      renderer.autoClear = true;
      bloom.render(renderer, null, rt, 0, false);
      let src = rt.texture;
      if (dof && this.lens.aperture > 0) {
        const u = dof.material.uniforms;
        u.uNear.value = camera.near;
        u.uFar.value = camera.far;
        u.uFocus.value = this.lens.focus;
        u.uAperture.value = this.lens.aperture;
        renderer.setRenderTarget(dofRT);
        dof.render(renderer);
        src = dofRT.texture;
      }
      grade.material.uniforms.tColor.value = src;
      grade.material.uniforms.uTime.value = t;
      // exposure: a number, or per-channel gains (exposure × white balance, world/camera.js)
      const e = this.lens.exposure ?? 1;
      if (typeof e === "number") grade.material.uniforms.uExposure.value.setScalar(e);
      else grade.material.uniforms.uExposure.value.copy(e);
      renderer.setRenderTarget(null);
      grade.render(renderer);
    },
  };
}
