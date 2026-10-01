import math
INK='#CFD9E3'; BG='#05080C'
def mark(stroke=2.0, color='currentColor'):
    # aperture: outer ring, hexagonal opening, six blade edges running from each corner to the ring
    cx=cy=16; R=13.5; r=6.5
    hexp=[(cx+r*math.sin(math.radians(a)), cy-r*math.cos(math.radians(a))) for a in range(0,360,60)]
    hexd='M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in hexp)+' Z'
    blades=[]
    for i,(x,y) in enumerate(hexp):
        # direction: along the next hexagon edge, extended to the ring (the classic iris look)
        nx,ny=hexp[(i+1)%6]; dx,dy=x-nx,y-ny; L=math.hypot(dx,dy); dx/=L; dy/=L
        # solve |p + t d - c| = R
        px,py=x-cx,y-cy; b=px*dx+py*dy; c=px*px+py*py-R*R; t=-b+math.sqrt(b*b-c)
        blades.append(f'M{x:.2f} {y:.2f} L{x+t*dx:.2f} {y+t*dy:.2f}')
    return (f'<g fill="none" stroke="{color}" stroke-width="{stroke}" stroke-linejoin="round" stroke-linecap="round">'
            f'<circle cx="16" cy="16" r="{R}"/><path d="{hexd}"/><path d="{" ".join(blades)}"/></g>')
def svg(inner, size=32, vb='0 0 32 32', extra=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{size}" height="{size}">{extra}{inner}</svg>'
# tile icon (tab, home screen): dark rounded square, light mark, scaled to leave padding
tile=lambda stroke: svg(f'<rect width="32" height="32" rx="7" fill="{BG}"/><g transform="translate(3.2 3.2) scale(0.8)">{mark(stroke, INK)}</g>')
open('favicon.svg','w').write(tile(2.6))
open('tile-big.svg','w').write(tile(2.0))
open('mark.txt','w').write(mark())
print(mark())
# 16 px variant: no ring (the tile edge does that job), thick strokes, mark fills the tile
def small(stroke, r=6.8, R=14.2, ring=False):
    cx=cy=16
    hexp=[(cx+r*math.sin(math.radians(a)), cy-r*math.cos(math.radians(a))) for a in range(0,360,60)]
    hexd='M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in hexp)+' Z'
    bl=[]
    for i,(x,y) in enumerate(hexp):
        nx,ny=hexp[(i+1)%6]; dx,dy=x-nx,y-ny; L=math.hypot(dx,dy); dx/=L; dy/=L
        px,py=x-cx,y-cy; b=px*dx+py*dy; c=px*px+py*py-R*R; t=-b+math.sqrt(b*b-c)
        bl.append(f'M{x:.2f} {y:.2f} L{x+t*dx:.2f} {y+t*dy:.2f}')
    ringd = f'<circle cx="16" cy="16" r="{R}"/>' if ring else ''
    return f'<g fill="none" stroke="{INK}" stroke-width="{stroke}" stroke-linejoin="round" stroke-linecap="round">{ringd}<path d="{hexd}"/><path d="{" ".join(bl)}"/></g>'
open('fav16a.svg','w').write(svg(f'<rect width="32" height="32" rx="7" fill="{BG}"/><g transform="translate(1.6 1.6) scale(0.9)">{small(3.2, ring=True, R=13.4)}</g>'))
open('fav16b.svg','w').write(svg(f'<rect width="32" height="32" rx="16" fill="{BG}"/>{small(3.0, R=15.5)}'))
open('fav16d.svg','w').write(svg(f'<circle cx="16" cy="16" r="16" fill="{BG}"/>{small(3.0, r=6.4, R=13.6, ring=True)}'))
