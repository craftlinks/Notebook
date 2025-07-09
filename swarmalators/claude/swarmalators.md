
# “Swårmalätørs”

## Oscillators that sync and swarm

### Patterns that emerge when collective motion and synchronization entangle

*Explorable by [Dirk Brockmann](https://synosys.github.io/)*  
*18 November 2019*

This explorable illustrates how remarkable **spatio‑temporal patterns** can emerge when two dynamical phenomena, [synchronization](https://en.wikipedia.org/wiki/Synchronization) and [collective motion](https://en.wikipedia.org/wiki/Collective_animal_behavior), are combined.  
In the model, a bunch of oscillators move around in space and interact.  
Each oscillator has an internal **oscillatory phase**.  
An oscillator’s movement and change of internal phase both depend on the positions and internal phases of all other oscillators.

Because of this entanglement of spatial forces and phase coupling the oscillators are called **swarmalators**.

The model was recently introduced and studied by [Kevin P. O’Keeffe](https://twitter.com/kevokeeffe), [Hyunsuk Hong](http://wz.jbnu.ac.kr), and [Steven Strogatz](https://twitter.com/stevenstrogatz) in the paper  
> O’Keeffe *et al.* “Oscillators that sync and swarm”, **Nature Communications** 8 : 1504 (2017).

It may capture effects observed in biological systems, e.g. populations of chemotactic microorganisms or bacterial biofilms.  
Recently swarmalators were realized in groups of [little robots](https://www.youtube.com/watch?v=Q9Xf4bN6zxo) and a [flock of drones](https://www.youtube.com/watch?v=djtuamVUPBw).

> **Press “Play”, count to 100 ( ! ), and keep on reading…**

---

## This is how it works

Here we have $N = 500$ swarmalators.  
The state of swarmalator $n$ is defined by three variables: the internal phase $\theta_n(t)$ and the two positional variables $x_n(t)$ and $y_n(t)$.  
The phase is depicted by a colour taken from a continuous rainbow colour‑wheel.  
Initially, the swarmalators’ phase variable is random, all of them are placed randomly in the plane, and all are at rest.  
For the math‑savvy reader the equations of motion that govern the system are discussed below.

Here we will outline the mechanics **qualitatively**.

### Movements

The swarmalators are subject to two opposing forces.

* **Short‑range repulsion** – when two swarmalators come too close, a repulsive force dominates and pushes them apart so they avoid bumping into each other. This force is negligible when swarmalators are far apart.  
* **Long‑range attraction** – any two swarmalators experience a force that pulls them towards each other whose magnitude does *not* decrease with distance.  
  The crucial point is that this attractive force between swarmalators $n$ and $m$ depends on their phase difference $\theta_m - \theta_n$.

When the *“like‑attracts‑like”* parameter $J$ is **positive**, similarity in phase enhances the attractive force; when $J$ is **negative**, swarmalators are more strongly attracted to others of *opposite* phase.

### Synchronization

The swarmalators’ phases advance at a constant phase velocity (natural frequency) $\omega$ like an internal clock.  
Additionally, a swarmalator’s phase also changes as a function of the phases of the other swarmalators.

* If the synchronization parameter $K > 0$ the phase difference $\theta_m - \theta_n$ between two swarmalators tends to **decrease** and they synchronize.  
* If $K < 0$ the opposite occurs and they **desynchronize**.

The magnitude of this phase‑coupling force decreases with distance and therefore depends on the positions of the swarmalators.  
(Phase‑coupled synchronization is also explored in the Explorables “Ride my Kuramotocycle” and “Janus Bunch”.)

---

## Observe this

You can observe a variety of **stationary or dynamic patterns** in this simple model just by changing the two parameters $J$ and $K$ with the corresponding sliders.  
Radio buttons help selecting parameter combinations that automatically yield different patterns.  
*Freezing the phase* turns on a comoving reference frame along the phase dimension so only relative phases are colour‑coded.

* **Rainbow Ring** – emerges when the synchronization force vanishes and $J > 0$. Swarmalators sort themselves into a stationary ring pattern. Patience required.  
* **Dancing Circus** – swarmalators are attracted to similar phase but desynchronize when close, leading to a never‑settling dynamic pattern. Needs a little time to get moving.  
* **Uniform Blob** – with very strong synchronization the swarmalators eventually settle into a regular, fully synced, stable state.  
* **Solar Convection** – like Uniform Blob but with heterogeneous natural frequencies $\omega_n$. Swarmalators with disparate $\omega_n$ migrate to the periphery, reminiscent of convection.  
* **Makes Me Dizzy** – complementary to Solar Convection: weak but positive sync ($K$ small) and strong “like‑attracts‑like” ($J$ large). Highly dynamic and beautiful once it sets in (turn on *Freeze Phase*).  
* **Fractured** – very strong “like‑attracts‑like” and slight desynchronization. After a transient ring pattern a “slice‑of‑orange” pattern emerges – patience rewarded.

---

## The math

The dynamical equations that define the model are a set of coupled differential equations for the **positions** and **phases** of the swarmalators.  
Denote the position vector of swarmalator $n$ by $\mathbf{r}_n = (x_n, y_n)$.  
Then

$$
\frac{d\mathbf{r}_n}{dt} = \mathbf{v}_n
  + \frac{1}{N} \sum_{m \neq n}
    \frac{\mathbf{r}_m - \mathbf{r}_n}{\lVert \mathbf{r}_m - \mathbf{r}_n \rVert}\,
    \bigl(1 + J\cos(\theta_m - \theta_n)\bigr)
  - \frac{\mathbf{r}_m - \mathbf{r}_n}{\lVert \mathbf{r}_m - \mathbf{r}_n \rVert^{\,2}}
$$

and

$$
\frac{d\theta_n}{dt} = \omega_n
  + \frac{K}{N} \sum_{m \neq n}
    \frac{\sin(\theta_m - \theta_n)}
         {\lVert \mathbf{r}_m - \mathbf{r}_n \rVert}
$$

In the first equation we see three contributions to the velocity:

1. $\mathbf{v}_n$ is the swarmalator’s natural propulsion velocity (set to zero in the explorable).  
2. The attraction term, modulated by the factor $1 + J\cos(\theta_m - \theta_n)$.  
3. The pure repulsive term proportional to the inverse squared distance.

The modulation **enhances** attraction when $J > 0$ and **suppresses** it when $J < 0$.

In the second equation $\omega_n$ is the natural frequency of swarmalator $n$.  
The coupling term is Kuramoto‑like: for $K > 0$ it decreases the phase difference between oscillators.  
Because the coupling strength decreases with distance, spatial positions enter the phase dynamics.

---

## Further information

* O’Keeffe, Hong & Strogatz, “Oscillators that sync and swarm”, **Nat. Comm. 8:1504** (2017).  
* O’Keeffe, Evers & Kolokolnikov, “Ring states in swarmalator systems”, **Phys. Rev. E 98:022203** (2018).  
* O’Keeffe & Bettstetter, “A review of swarmalators and their potential in bio‑inspired computing”, *SPIE 10982* (2019).  
* Hong, “Active phase wave in the system of swarmalators with attractive phase coupling”, **Chaos 28:103112** (2018).

---

© Dirk Brockmann, 2025 – *Complexity Explorables*  
Licensed under a [Creative Commons Attribution 2.0 Germany License](https://creativecommons.org/licenses/by/2.0/de/deed.en).

